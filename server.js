require('dotenv').config();
const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Paths & Database ──────────────────────────────────────────────────────────
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const db = new Database(path.join(CONFIG_DIR, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS watched (
    tmdb_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL DEFAULT 'movie',
    title      TEXT,
    watched_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tmdb_id, media_type)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmtInsertWatched = db.prepare(
  `INSERT OR IGNORE INTO watched (tmdb_id, media_type, title) VALUES (?, ?, ?)`
);
const stmtDeleteWatched = db.prepare(
  `DELETE FROM watched WHERE tmdb_id = ? AND media_type = ?`
);
const stmtGetWatchedIds = db.prepare(
  `SELECT tmdb_id, media_type FROM watched`
);
const stmtGetSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const stmtSetSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTING_KEYS = [
  'tmdb_api_key',
  'radarr_url',
  'radarr_api_key',
  'sonarr_url',
  'sonarr_api_key',
];

const envDefaults = {
  tmdb_api_key:   process.env.TMDB_API_KEY   || '',
  radarr_url:     process.env.RADARR_URL     || 'http://localhost:7878',
  radarr_api_key: process.env.RADARR_API_KEY || '',
  sonarr_url:     process.env.SONARR_URL     || 'http://localhost:8989',
  sonarr_api_key: process.env.SONARR_API_KEY || '',
};

function getSetting(key) {
  const row = stmtGetSetting.get(key);
  if (row && row.value) return row.value;
  return envDefaults[key] || '';
}

function setSetting(key, value) {
  stmtSetSetting.run(key, value == null ? '' : String(value));
}

function allSettings() {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = getSetting(key);
  return out;
}

// ── SWR LRU cache ─────────────────────────────────────────────────────────────
// Serve fresh values instantly; serve stale values instantly while refreshing
// in the background. Dedupe in-flight requests per key.
class SWRCache {
  constructor(max = 5000) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.hardExpire) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  set(key, value, { freshTtl, staleTtl }) {
    if (this.map.size >= this.max && !this.map.has(key)) {
      this.map.delete(this.map.keys().next().value);
    }
    const now = Date.now();
    this.map.set(key, {
      value,
      softExpire: now + freshTtl,
      hardExpire: now + freshTtl + staleTtl,
    });
  }
  stats() {
    return { size: this.map.size };
  }
}

const tmdbCache = new SWRCache(5000);
const statusCache = new SWRCache(2000);
const inFlight = new Map();

// ── TMDB ──────────────────────────────────────────────────────────────────────
const TMDB = 'https://api.themoviedb.org/3';

// Policies: list endpoints refresh often; per-id metadata is essentially static.
const POLICY_LIST   = { freshTtl: 10 * 60_000,   staleTtl: 60 * 60_000   }; // 10m fresh / 1h stale
const POLICY_STATIC = { freshTtl:  6 * 60 * 60_000, staleTtl: 48 * 60 * 60_000 }; // 6h / 48h
const POLICY_SEARCH = { freshTtl:  5 * 60_000,   staleTtl: 30 * 60_000   };
const POLICY_STATUS = { freshTtl: 30_000,        staleTtl: 5 * 60_000    };

function fetchTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function tmdbRaw(endpoint, params = {}) {
  const key = getSetting('tmdb_api_key');
  if (!key) throw new Error('TMDB API key not configured — open Settings → General');
  const url = new URL(`${TMDB}${endpoint}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchTimeout(url.toString());
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  return res.json();
}

async function tmdb(endpoint, params = {}, policy = POLICY_STATIC) {
  const cacheKey = endpoint + (Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString() : '');
  const now = Date.now();
  const entry = tmdbCache.get(cacheKey);

  if (entry && entry.hardExpire > now) {
    // Stale-while-revalidate: kick off a refresh if past freshness.
    if (entry.softExpire <= now && !inFlight.has(cacheKey)) {
      const p = tmdbRaw(endpoint, params)
        .then((v) => { tmdbCache.set(cacheKey, v, policy); inFlight.delete(cacheKey); })
        .catch(() => { inFlight.delete(cacheKey); });
      inFlight.set(cacheKey, p);
    }
    return entry.value;
  }

  // Miss — dedupe concurrent requests for the same key.
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const promise = tmdbRaw(endpoint, params)
    .then((v) => { tmdbCache.set(cacheKey, v, policy); inFlight.delete(cacheKey); return v; })
    .catch((err) => { inFlight.delete(cacheKey); throw err; });
  inFlight.set(cacheKey, promise);
  return promise;
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function normalizeUrl(u) { return (u || '').trim().replace(/\/$/, ''); }
function poster(p)   { return p ? `https://image.tmdb.org/t/p/w500${p}` : null; }
function backdrop(p) { return p ? `https://image.tmdb.org/t/p/w780${p}` : null; }

function pickTrailer(videos) {
  if (!videos || !Array.isArray(videos.results)) return null;
  // Prefer Trailer > Teaser; official flagged first.
  const youtubes = videos.results.filter((v) => v.site === 'YouTube');
  const trailer = youtubes.find((v) => v.type === 'Trailer' && v.official)
               || youtubes.find((v) => v.type === 'Trailer')
               || youtubes.find((v) => v.type === 'Teaser');
  return trailer || null;
}

// ── Feed builders (reusable by routes + SSR + prewarm) ───────────────────────
async function buildMovieFeed({ list, page }) {
  const data = await tmdb(`/movie/${list}`, { page }, POLICY_LIST);
  const movies = data.results || [];
  const enriched = await Promise.all(movies.map(async (movie) => {
    try {
      const videos = await tmdb(`/movie/${movie.id}/videos`, {}, POLICY_STATIC);
      const trailer = pickTrailer(videos);
      if (!trailer) return null;
      return {
        id: movie.id,
        title: movie.title,
        overview: movie.overview,
        release_date: movie.release_date,
        poster_path: poster(movie.poster_path),
        backdrop_path: backdrop(movie.backdrop_path),
        vote_average: movie.vote_average,
        youtube_key: trailer.key,
        media_type: 'movie',
      };
    } catch { return null; }
  }));
  return {
    results: enriched.filter(Boolean),
    total_pages: data.total_pages,
    page: data.page,
  };
}

async function buildTvFeed({ list, page }) {
  const data = list === 'trending'
    ? await tmdb('/trending/tv/week', { page }, POLICY_LIST)
    : await tmdb(`/tv/${list}`, { page }, POLICY_LIST);
  const shows = data.results || [];
  const enriched = await Promise.all(shows.map(async (show) => {
    try {
      const [videos, extIds] = await Promise.all([
        tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC),
        tmdb(`/tv/${show.id}/external_ids`, {}, POLICY_STATIC),
      ]);
      const trailer = pickTrailer(videos);
      if (!trailer) return null;
      return {
        id: show.id,
        tvdb_id: extIds.tvdb_id || null,
        title: show.name,
        overview: show.overview,
        release_date: show.first_air_date,
        poster_path: poster(show.poster_path),
        backdrop_path: backdrop(show.backdrop_path),
        vote_average: show.vote_average,
        youtube_key: trailer.key,
        media_type: 'tv',
      };
    } catch { return null; }
  }));
  return {
    results: enriched.filter(Boolean),
    total_pages: data.total_pages,
    page: data.page,
  };
}

async function buildMovieSearch(q) {
  const data = await tmdb('/search/movie', { query: q }, POLICY_SEARCH);
  const movies = (data.results || []).slice(0, 20);
  const enriched = await Promise.all(movies.map(async (movie) => {
    try {
      const videos = await tmdb(`/movie/${movie.id}/videos`, {}, POLICY_STATIC);
      const trailer = pickTrailer(videos);
      return {
        id: movie.id,
        title: movie.title,
        overview: movie.overview,
        release_date: movie.release_date,
        poster_path: poster(movie.poster_path),
        backdrop_path: backdrop(movie.backdrop_path),
        vote_average: movie.vote_average,
        youtube_key: trailer ? trailer.key : null,
        media_type: 'movie',
      };
    } catch { return null; }
  }));
  return { results: enriched.filter(Boolean) };
}

async function buildTvSearch(q) {
  const data = await tmdb('/search/tv', { query: q }, POLICY_SEARCH);
  const shows = (data.results || []).slice(0, 20);
  const enriched = await Promise.all(shows.map(async (show) => {
    try {
      const [videos, extIds] = await Promise.all([
        tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC),
        tmdb(`/tv/${show.id}/external_ids`, {}, POLICY_STATIC),
      ]);
      const trailer = pickTrailer(videos);
      return {
        id: show.id,
        tvdb_id: extIds.tvdb_id || null,
        title: show.name,
        overview: show.overview,
        release_date: show.first_air_date,
        poster_path: poster(show.poster_path),
        backdrop_path: backdrop(show.backdrop_path),
        vote_average: show.vote_average,
        youtube_key: trailer ? trailer.key : null,
        media_type: 'tv',
      };
    } catch { return null; }
  }));
  return { results: enriched.filter(Boolean) };
}

// ── Prewarm + background refresh ─────────────────────────────────────────────
const WARM_LISTS = [
  { mode: 'movies', list: 'upcoming'   },
  { mode: 'movies', list: 'now_playing'},
  { mode: 'movies', list: 'popular'    },
  { mode: 'tv',     list: 'trending'   },
  { mode: 'tv',     list: 'popular'    },
  { mode: 'tv',     list: 'on_the_air' },
  { mode: 'tv',     list: 'top_rated'  },
];

let prewarmRunning = false;
let prewarmTimer = null;

async function prewarm({ label = 'prewarm' } = {}) {
  if (prewarmRunning) return;
  if (!getSetting('tmdb_api_key')) return;
  prewarmRunning = true;
  const start = Date.now();
  let ok = 0, fail = 0;
  // Serial across lists to avoid TMDB rate-limit bursts.
  for (const { mode, list } of WARM_LISTS) {
    try {
      if (mode === 'movies') await buildMovieFeed({ list, page: 1 });
      else await buildTvFeed({ list, page: 1 });
      ok++;
    } catch (e) {
      fail++;
      console.warn(`[${label}] ${mode}/${list}: ${e.message}`);
    }
  }
  prewarmRunning = false;
  console.log(`[${label}] ${ok}/${ok + fail} lists warmed in ${Date.now() - start}ms (cache size: ${tmdbCache.stats().size})`);
}

function schedulePrewarm() {
  if (prewarmTimer) clearInterval(prewarmTimer);
  prewarmTimer = setInterval(() => prewarm({ label: 'refresh' }), 8 * 60_000);
  prewarmTimer.unref?.();
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());

// Disable ETags — ZFS doesn't reliably update mtime on writes,
// causing stale browser caches even after file edits.
const STATIC_OPTS = {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 1 week for static binaries
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};

// ── SSR for / ────────────────────────────────────────────────────────────────
const indexTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function safeJson(obj) {
  // Prevent `</script>` injection when inlining JSON into HTML.
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  let initialFeed = null;
  let initialWatched = [];
  try {
    initialWatched = stmtGetWatchedIds.all();
  } catch {}
  try {
    // Short total budget — if TMDB is slow, don't hold up first paint.
    initialFeed = await Promise.race([
      buildMovieFeed({ list: 'upcoming', page: 1 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch {}

  const boot = `<script>
window.__INITIAL_FEED__ = ${safeJson(initialFeed)};
window.__INITIAL_WATCHED__ = ${safeJson(initialWatched)};
window.__INITIAL_LIST__ = "upcoming";
</script>`;

  res.send(indexTemplate.replace('</body>', `${boot}\n</body>`));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.use(express.static(path.join(__dirname, 'public'), STATIC_OPTS));

// ── Cache-control helpers ─────────────────────────────────────────────────────
function publicCache(res, seconds) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}`);
}

// ── Feed routes ──────────────────────────────────────────────────────────────
app.get('/api/feed', async (req, res) => {
  try {
    const payload = await buildMovieFeed({
      list: req.query.list || 'upcoming',
      page: req.query.page || 1,
    });
    publicCache(res, 60);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shows/feed', async (req, res) => {
  try {
    const payload = await buildTvFeed({
      list: req.query.list || 'trending',
      page: req.query.page || 1,
    });
    publicCache(res, 60);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const payload = await buildMovieSearch(q);
    publicCache(res, 120);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shows/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const payload = await buildTvSearch(q);
    publicCache(res, 120);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Radarr routes ─────────────────────────────────────────────────────────────
async function radarr(method, endpoint, body) {
  const base = normalizeUrl(getSetting('radarr_url'));
  const key  = getSetting('radarr_api_key');
  if (!base || !key) throw new Error('Radarr not configured — open Settings → Applications');
  const url = `${base}/api/v3${endpoint}`;
  const opts = {
    method,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchTimeout(url, opts, 6000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Radarr ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function radarrStatusById(tmdbId) {
  const ckey = `radarr:${tmdbId}`;
  const cached = statusCache.get(ckey);
  if (cached && cached.hardExpire > Date.now()) return cached.value;
  const results = await radarr('GET', `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
  const movie = Array.isArray(results) ? results[0] : results;
  const status = {
    exists: !!(movie && movie.id),
    monitored: movie ? movie.monitored : false,
    hasFile: movie ? movie.hasFile : false,
  };
  statusCache.set(ckey, status, POLICY_STATUS);
  return status;
}

app.get('/api/radarr/lookup/:tmdbId', async (req, res) => {
  try {
    const status = await radarrStatusById(req.params.tmdbId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/radarr/lookup', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.tmdbIds) ? req.body.tmdbIds : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await radarrStatusById(id); }
      catch { out[id] = { exists: false, error: true }; }
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/radarr/config', async (req, res) => {
  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      radarr('GET', '/rootfolder'),
      radarr('GET', '/qualityprofile'),
    ]);
    res.json({ rootFolders, qualityProfiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/radarr/add', async (req, res) => {
  try {
    const { tmdbId, qualityProfileId, rootFolderPath } = req.body;
    if (!tmdbId || !qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lookupResults = await radarr('GET', `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
    const lookupMovie = Array.isArray(lookupResults) ? lookupResults[0] : lookupResults;
    if (!lookupMovie) return res.status(404).json({ error: 'Movie not found in TMDB via Radarr' });

    const payload = {
      ...lookupMovie,
      qualityProfileId: parseInt(qualityProfileId),
      rootFolderPath,
      monitored: true,
      addOptions: { searchForMovie: true },
    };
    const result = await radarr('POST', '/movie', payload);
    statusCache.set(`radarr:${tmdbId}`, { exists: true, monitored: true, hasFile: false }, POLICY_STATUS);
    res.json({ success: true, movie: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sonarr routes ─────────────────────────────────────────────────────────────
async function sonarr(method, endpoint, body) {
  const base = normalizeUrl(getSetting('sonarr_url'));
  const key  = getSetting('sonarr_api_key');
  if (!base || !key) throw new Error('Sonarr not configured — open Settings → Applications');
  const url = `${base}/api/v3${endpoint}`;
  const opts = {
    method,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchTimeout(url, opts, 6000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Sonarr ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function sonarrStatusByTvdb(tvdbId) {
  const ckey = `sonarr:${tvdbId}`;
  const cached = statusCache.get(ckey);
  if (cached && cached.hardExpire > Date.now()) return cached.value;
  const results = await sonarr('GET', `/series/lookup?term=tvdb:${tvdbId}`);
  const show = Array.isArray(results) ? results[0] : results;
  const status = {
    exists: !!(show && show.id),
    monitored: show ? show.monitored : false,
    hasFile: show ? (show.statistics ? show.statistics.episodeFileCount > 0 : false) : false,
  };
  statusCache.set(ckey, status, POLICY_STATUS);
  return status;
}

app.get('/api/sonarr/lookup/:tvdbId', async (req, res) => {
  try {
    const status = await sonarrStatusByTvdb(req.params.tvdbId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sonarr/lookup', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.tvdbIds) ? req.body.tvdbIds : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await sonarrStatusByTvdb(id); }
      catch { out[id] = { exists: false, error: true }; }
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sonarr/config', async (req, res) => {
  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      sonarr('GET', '/rootfolder'),
      sonarr('GET', '/qualityprofile'),
    ]);
    res.json({ rootFolders, qualityProfiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sonarr/add', async (req, res) => {
  try {
    const { tvdbId, qualityProfileId, rootFolderPath } = req.body;
    if (!tvdbId || !qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lookupResults = await sonarr('GET', `/series/lookup?term=tvdb:${tvdbId}`);
    const lookupShow = Array.isArray(lookupResults) ? lookupResults[0] : lookupResults;
    if (!lookupShow) return res.status(404).json({ error: 'Show not found via Sonarr' });

    const payload = {
      ...lookupShow,
      qualityProfileId: parseInt(qualityProfileId),
      rootFolderPath,
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: true },
    };
    const result = await sonarr('POST', '/series', payload);
    statusCache.set(`sonarr:${tvdbId}`, { exists: true, monitored: true, hasFile: false }, POLICY_STATUS);
    res.json({ success: true, show: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Watched routes ────────────────────────────────────────────────────────────
app.get('/api/watched/ids', (req, res) => {
  res.json(stmtGetWatchedIds.all());
});

app.post('/api/watched', (req, res) => {
  const { tmdbId, mediaType = 'movie', title } = req.body;
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required' });
  stmtInsertWatched.run(tmdbId, mediaType, title || null);
  res.json({ ok: true });
});

app.delete('/api/watched/:tmdbId', (req, res) => {
  const { mediaType = 'movie' } = req.query;
  stmtDeleteWatched.run(parseInt(req.params.tmdbId), mediaType);
  res.json({ ok: true });
});

// ── Settings routes ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(allSettings()));

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const prevTmdb = getSetting('tmdb_api_key');
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    let val = body[key] == null ? '' : String(body[key]).trim();
    if (key === 'radarr_url' || key === 'sonarr_url') val = normalizeUrl(val);
    setSetting(key, val);
  }
  res.json({ ok: true, settings: allSettings() });

  // Kick off a prewarm if TMDB key was just added or changed.
  const newTmdb = getSetting('tmdb_api_key');
  if (newTmdb && newTmdb !== prevTmdb) {
    setImmediate(() => prewarm({ label: 'post-save prewarm' }));
  }
});

app.post('/api/settings/test', async (req, res) => {
  const { service, url, apiKey } = req.body || {};
  try {
    if (service === 'tmdb') {
      const key = apiKey || getSetting('tmdb_api_key');
      if (!key) throw new Error('TMDB API key is empty');
      const r = await fetchTimeout(`${TMDB}/configuration?api_key=${encodeURIComponent(key)}`, {}, 6000);
      if (!r.ok) throw new Error(`TMDB ${r.status}`);
    } else if (service === 'radarr' || service === 'sonarr') {
      const base = normalizeUrl(url || getSetting(`${service}_url`));
      const key  = apiKey || getSetting(`${service}_api_key`);
      if (!base) throw new Error('URL is empty');
      if (!key)  throw new Error('API key is empty');
      const r = await fetchTimeout(`${base}/api/v3/system/status`, {
        headers: { 'X-Api-Key': key },
      }, 6000);
      if (!r.ok) throw new Error(`${service} ${r.status}`);
      const info = await r.json();
      return res.json({ ok: true, version: info.version, name: info.instanceName || info.appName });
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown service' });
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : err.message;
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    tmdb: !!getSetting('tmdb_api_key'),
    radarr_url: getSetting('radarr_url'),
    radarr_key: !!getSetting('radarr_api_key'),
    sonarr_url: getSetting('sonarr_url'),
    sonarr_key: !!getSetting('sonarr_api_key'),
    cache: { tmdb: tmdbCache.stats(), status: statusCache.stats() },
  });
});

// ── Go ────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Peekarr running at http://localhost:${PORT}`);
  console.log(`Config directory: ${CONFIG_DIR}`);
  if (!getSetting('tmdb_api_key')) {
    console.warn('  Note: TMDB not configured yet — visit /settings');
  } else {
    setImmediate(() => prewarm({ label: 'startup prewarm' }));
    schedulePrewarm();
  }
});
