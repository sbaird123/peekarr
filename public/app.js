// ── Utilities ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Swipe history (localStorage) ─────────────────────────────────────────────
const HISTORY_KEY = 'peekarr_skips';
const MAX_HISTORY = 500;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }
function recordSkip(tmdbId) {
  const h = loadHistory();
  h[tmdbId] = (h[tmdbId] || 0) + 1;
  const keys = Object.keys(h);
  if (keys.length > MAX_HISTORY) {
    keys.sort((a, b) => h[a] - h[b]).slice(0, keys.length - MAX_HISTORY).forEach((k) => delete h[k]);
  }
  saveHistory(h);
}
function skipProbability(tmdbId) {
  const count = loadHistory()[tmdbId] || 0;
  if (count === 0) return 0;
  return Math.min(0.8, 1 - Math.pow(0.7, count));
}

// ── Watched ──────────────────────────────────────────────────────────────────
function watchedKey(tmdbId, mediaType) { return `${tmdbId}:${mediaType || 'movie'}`; }

async function loadWatched() {
  try {
    const res = await fetch('/api/watched/ids');
    const rows = await res.json();
    watchedSet = new Set(rows.map((r) => watchedKey(r.tmdb_id, r.media_type)));
  } catch {}
}

async function markWatched(item) {
  watchedSet.add(watchedKey(item.id, item.media_type));
  try {
    await fetch('/api/watched', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: item.id, mediaType: item.media_type || 'movie', title: item.title }),
    });
  } catch {}
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode = 'movies';
let currentList = window.__INITIAL_LIST__ || 'upcoming';
let currentPage = 1;
let totalPages = 1;
let loading = false;
let feedAbortController = null;
let statusAbortController = null;
let swiper = null;
let watchedSet = new Set();
let radarrConfig = null;
let sonarrConfig = null;
let pendingItem = null;
let players = {};
let playerReady = {};
let ytApiReady = false;
let ytApiCallbacks = [];
let ytApiLoaded = false;
let itemCache = [];

const PLAYER_WINDOW = 1; // keep players at current ± N slides; destroy the rest

const TABS = {
  movies: [
    { list: 'upcoming',    label: 'Upcoming' },
    { list: 'now_playing', label: 'Now Playing' },
    { list: 'popular',     label: 'Popular' },
  ],
  tv: [
    { list: 'trending',    label: 'Trending' },
    { list: 'popular',     label: 'Popular' },
    { list: 'on_the_air',  label: 'On Air' },
    { list: 'top_rated',   label: 'Top Rated' },
  ],
};

// ── YouTube IFrame API (lazy) ─────────────────────────────────────────────────
// Load the YT script only when we actually need a player, so first paint
// doesn't pay the cost.
window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  ytApiCallbacks.forEach((cb) => cb());
  ytApiCallbacks = [];
};

function loadYtApi() {
  if (ytApiLoaded) return;
  ytApiLoaded = true;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.async = true;
  document.head.appendChild(s);
}

function whenYtReady(cb) {
  if (ytApiReady) return cb();
  ytApiCallbacks.push(cb);
  loadYtApi();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function setLoading(on) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !on);
}

// ── Service config (cached) ───────────────────────────────────────────────────
async function getRadarrConfig() {
  if (radarrConfig) return radarrConfig;
  const res = await fetch('/api/radarr/config');
  if (!res.ok) throw new Error('Cannot reach Radarr — check Settings → Applications');
  radarrConfig = await res.json();
  return radarrConfig;
}

async function getSonarrConfig() {
  if (sonarrConfig) return sonarrConfig;
  const res = await fetch('/api/sonarr/config');
  if (!res.ok) throw new Error('Cannot reach Sonarr — check Settings → Applications');
  sonarrConfig = await res.json();
  return sonarrConfig;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function renderTabs() {
  const container = document.getElementById('nav-tabs');
  container.innerHTML = '';
  TABS[currentMode].forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (t.list === currentList ? ' active' : '');
    btn.dataset.list = t.list;
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      if (t.list === currentList) return;
      currentList = t.list;
      renderTabs();
      loadFeed(true);
    });
    container.appendChild(btn);
  });
  document.getElementById('search-input').placeholder =
    currentMode === 'movies' ? 'Search movies...' : 'Search TV shows...';
}

// ── Slide builder (with YouTube facade) ──────────────────────────────────────
function ytThumb(key) {
  // hqdefault is guaranteed to exist; maxresdefault is nicer but not always.
  // Try maxres first via img onerror fallback.
  return {
    primary: `https://i.ytimg.com/vi/${key}/maxresdefault.jpg`,
    fallback: `https://i.ytimg.com/vi/${key}/hqdefault.jpg`,
  };
}

function buildSlide(item, index) {
  const isTv = item.media_type === 'tv';
  const slide = document.createElement('div');
  slide.className = 'swiper-slide';
  slide.dataset.index = index;
  slide.dataset.tmdbId = item.id;
  slide.dataset.mediaType = item.media_type || 'movie';

  const safeTitle = (item.title || '').replace(/"/g, '&quot;');
  const year = item.release_date ? item.release_date.slice(0, 4) : '';
  const btnClass = isTv ? 'btn-sonarr' : 'btn-radarr';
  const btnLabel = isTv ? '+ Add to Sonarr' : '+ Add to Radarr';
  const thumb = ytThumb(item.youtube_key);

  slide.innerHTML = `
    <div class="slide-bg" style="background-image:url('${item.backdrop_path || item.poster_path || ''}')"></div>
    <div class="video-wrap" id="vwrap-${index}">
      <div class="yt-facade" id="yt-facade-${index}">
        <img class="yt-facade-img" src="${thumb.primary}" alt="" loading="lazy"
             onerror="this.onerror=null;this.src='${thumb.fallback}'" />
      </div>
      <div class="yt-mount" id="yt-${index}" hidden></div>
    </div>
    <div class="touch-shield" id="shield-${index}">
      <div class="play-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      </div>
    </div>
    <div class="slide-info">
      <div class="slide-title">${item.title}</div>
      <div class="slide-meta">
        <span class="rating">&#9733; ${item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}</span>
        <span>${year}</span>
        ${isTv ? '<span class="media-badge">TV</span>' : ''}
      </div>
      <div class="slide-overview">${item.overview || ''}</div>
      <div class="slide-actions">
        <button class="${btnClass}" data-tmdb-id="${item.id}" data-title="${safeTitle}" data-year="${year}" data-media-type="${item.media_type || 'movie'}">
          ${btnLabel}
        </button>
        <button class="btn-watched">Watched</button>
        <button class="btn-skip">Skip</button>
      </div>
    </div>
  `;

  let tapCount = 0;
  let tapTimer = null;
  slide.querySelector(`#shield-${index}`).addEventListener('click', () => {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => {
      if (tapCount >= 3) {
        openModal(item);
      } else {
        // First tap on a slide whose player hasn't materialized yet → create + play.
        const idx = parseInt(slide.dataset.index, 10);
        if (!players[idx]) ensurePlayer(item, idx);
        togglePlay(idx);
      }
      tapCount = 0;
    }, 300);
  });

  slide.querySelector('.btn-watched').addEventListener('click', async () => {
    await markWatched(item);
    toast(`"${item.title}" marked as watched`);
    if (swiper) swiper.slideNext();
  });

  slide.querySelector('.btn-skip').addEventListener('click', () => {
    recordSkip(item.id);
    if (swiper) swiper.slideNext();
  });

  slide.querySelector(`.${btnClass}`).addEventListener('click', () => openModal(item));

  return slide;
}

// ── YouTube player management ────────────────────────────────────────────────
function createPlayer(item, index) {
  if (players[index]) return;
  const mount = document.getElementById(`yt-${index}`);
  const facade = document.getElementById(`yt-facade-${index}`);
  if (!mount) return;
  mount.hidden = false;
  if (facade) facade.hidden = true;

  whenYtReady(() => {
    if (!document.getElementById(`yt-${index}`)) return; // slide removed before API loaded
    players[index] = new YT.Player(`yt-${index}`, {
      videoId: item.youtube_key,
      playerVars: {
        autoplay: 0,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
      },
      events: {
        onReady: (e) => {
          playerReady[index] = true;
          e.target.mute();
          if (swiper && swiper.activeIndex === index) autoPlaySlide(index);
        },
        onStateChange: (e) => {
          const shield = document.getElementById(`shield-${index}`);
          if (!shield) return;
          if (e.data === YT.PlayerState.PLAYING) shield.classList.add('playing');
          else shield.classList.remove('playing');
        },
      },
    });
  });
}

function destroyPlayer(index) {
  const p = players[index];
  if (!p) return;
  try { p.destroy(); } catch {}
  delete players[index];
  delete playerReady[index];
  // Restore facade so there's still something to look at.
  const mount  = document.getElementById(`yt-${index}`);
  const facade = document.getElementById(`yt-facade-${index}`);
  const shield = document.getElementById(`shield-${index}`);
  if (mount)  { mount.hidden = true; mount.innerHTML = ''; }
  if (facade) facade.hidden = false;
  if (shield) shield.classList.remove('playing');
}

function togglePlay(index) {
  const p = players[index];
  if (!p || !playerReady[index]) return;
  const state = p.getPlayerState();
  if (state === YT.PlayerState.PLAYING) {
    p.pauseVideo();
  } else {
    p.playVideo();
    p.unMute();
    p.setVolume(80);
  }
}

function autoPlaySlide(index) {
  Object.keys(players).forEach((i) => {
    if (parseInt(i) !== index && players[i] && playerReady[i]) {
      try { players[i].pauseVideo(); } catch {}
    }
  });
  const p = players[index];
  if (!p || !playerReady[index]) return;
  p.mute();
  p.playVideo();
  setTimeout(() => { try { p.unMute(); p.setVolume(70); } catch {} }, 600);
}

function ensurePlayer(item, index) {
  if (players[index]) return;
  createPlayer(item, index);
}

// Keep only a window of players around the active index; destroy the rest.
function gcPlayers(activeIdx) {
  const keep = new Set();
  for (let d = -PLAYER_WINDOW; d <= PLAYER_WINDOW; d++) keep.add(activeIdx + d);
  Object.keys(players).forEach((k) => {
    const i = parseInt(k, 10);
    if (!keep.has(i)) destroyPlayer(i);
  });
}

// ── Feed loading ──────────────────────────────────────────────────────────────
async function loadFeed(reset = false) {
  if (loading && !reset) return;
  if (!reset && currentPage > totalPages) return;

  if (reset) {
    if (feedAbortController) feedAbortController.abort();
    if (statusAbortController) statusAbortController.abort();
    statusAbortController = null;
  }
  feedAbortController = new AbortController();
  const signal = feedAbortController.signal;

  loading = true;

  if (reset) {
    const maxStartPage = currentMode === 'tv' ? 3 : 6;
    currentPage = Math.floor(Math.random() * maxStartPage) + 1;
    itemCache = [];
    // Destroy all existing players cleanly on reset.
    Object.keys(players).forEach((i) => destroyPlayer(parseInt(i, 10)));
    players = {};
    playerReady = {};
    setLoading(true);
  }

  try {
    const base = currentMode === 'tv'
      ? `/api/shows/feed?list=${currentList}`
      : `/api/feed?list=${currentList}`;

    let results, newTotalPages;

    if (reset) {
      const page2 = currentPage + 1;
      const [r1, r2] = await Promise.all([
        fetch(`${base}&page=${currentPage}`, { signal }).then((r) => r.json()),
        fetch(`${base}&page=${page2}`, { signal }).then((r) => r.json()),
      ]);
      if (r1.error) throw new Error(r1.error);
      newTotalPages = r1.total_pages;
      currentPage = page2 + 1;
      results = shuffle([...(r1.results || []), ...(r2.results || [])]);
    } else {
      const r = await fetch(`${base}&page=${currentPage}`, { signal }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      newTotalPages = r.total_pages;
      currentPage++;
      results = shuffle(r.results || []);
    }

    totalPages = newTotalPages;

    const filtered = results.filter((item) =>
      !watchedSet.has(watchedKey(item.id, item.media_type)) &&
      Math.random() >= skipProbability(item.id)
    );
    const startIndex = itemCache.length;
    itemCache.push(...filtered);

    const wrapper = document.getElementById('swiper-wrapper');
    if (reset) {
      if (swiper) swiper.slideTo(0, 0, false);
      wrapper.innerHTML = '';
    }

    filtered.forEach((item, i) => {
      wrapper.appendChild(buildSlide(item, startIndex + i));
    });

    if (!swiper) {
      initSwiper();
    } else {
      swiper.update();
      if (reset) {
        swiper.slideTo(0, 0, false);
        const first = itemCache[0];
        if (first) ensurePlayer(first, 0);
      }
    }

    statusAbortController = new AbortController();
    checkStatusBatch(filtered, statusAbortController.signal);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[loadFeed] error:', err);
      toast('Error: ' + err.message);
    }
  } finally {
    if (!signal.aborted) {
      loading = false;
      setLoading(false);
    }
  }
}

// ── Swiper init ───────────────────────────────────────────────────────────────
function initSwiper() {
  swiper = new Swiper('#main-swiper', {
    direction: 'vertical',
    slidesPerView: 1,
    speed: 380,
    resistanceRatio: 0.7,
    on: {
      slideChangeTransitionEnd(s) {
        const idx = s.activeIndex;
        const item = itemCache[idx];
        if (!item) return;

        const prev = itemCache[idx - 1];
        if (prev) recordSkip(prev.id);

        ensurePlayer(item, idx);
        autoPlaySlide(idx);

        // Warm neighbours so swiping feels instant; tear down anything further.
        for (let d = -PLAYER_WINDOW; d <= PLAYER_WINDOW; d++) {
          const ni = idx + d;
          if (ni >= 0 && ni < itemCache.length && !players[ni]) {
            createPlayer(itemCache[ni], ni);
          }
        }
        gcPlayers(idx);

        if (idx >= itemCache.length - 4) loadFeed();
      },
    },
  });

  const first = itemCache[0];
  if (first) {
    ensurePlayer(first, 0);
    if (itemCache[1]) createPlayer(itemCache[1], 1);
  }
}

// ── Status checks (Radarr + Sonarr) — batched ────────────────────────────────
async function checkStatusBatch(items, signal) {
  if (!items || !items.length) return;

  const movieIds = items.filter((i) => i.media_type !== 'tv').map((i) => i.id);
  const tvIds    = items.filter((i) => i.media_type === 'tv' && i.tvdb_id).map((i) => i.tvdb_id);

  const requests = [];
  if (movieIds.length) {
    requests.push(fetch('/api/radarr/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbIds: movieIds }),
      signal,
    }).then((r) => r.ok ? r.json() : {})
      .then((map) => {
        for (const id of Object.keys(map)) {
          const data = map[id];
          if (data && data.exists) markBtn(id, data.hasFile ? 'In Library' : 'In Radarr', 'exists');
        }
      })
      .catch(() => {}));
  }
  if (tvIds.length) {
    requests.push(fetch('/api/sonarr/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tvdbIds: tvIds }),
      signal,
    }).then((r) => r.ok ? r.json() : {})
      .then((map) => {
        // Map tvdbId → status; find the corresponding tmdb id for button marking.
        for (const tvdbId of Object.keys(map)) {
          const data = map[tvdbId];
          if (!data || !data.exists) continue;
          const item = items.find((i) => String(i.tvdb_id) === String(tvdbId));
          if (item) markBtn(item.id, data.hasFile ? 'In Library' : 'In Sonarr', 'exists');
        }
      })
      .catch(() => {}));
  }

  await Promise.all(requests);
}

function markBtn(tmdbId, label, cls) {
  ['.btn-radarr', '.btn-sonarr', '.search-add-btn'].forEach((sel) => {
    document.querySelectorAll(`${sel}[data-tmdb-id="${tmdbId}"]`).forEach((btn) => {
      btn.textContent = label;
      btn.classList.add(cls);
      btn.disabled = true;
    });
  });
}

// ── Modal (Radarr + Sonarr) ───────────────────────────────────────────────────
async function openModal(item) {
  pendingItem = item;
  const isTv = item.media_type === 'tv';

  try {
    const config = isTv ? await getSonarrConfig() : await getRadarrConfig();

    const qualSel = document.getElementById('modal-quality');
    const folderSel = document.getElementById('modal-folder');
    qualSel.innerHTML = '';
    folderSel.innerHTML = '';

    config.qualityProfiles.forEach((q) => {
      const opt = document.createElement('option');
      opt.value = q.id;
      opt.textContent = q.name;
      qualSel.appendChild(opt);
    });

    config.rootFolders.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.path;
      folderSel.appendChild(opt);
    });

    const service = isTv ? 'Sonarr' : 'Radarr';
    document.getElementById('modal-title').textContent = `Add "${item.title}" to ${service}`;
    document.getElementById('modal-confirm').textContent = `Add to ${service}`;
    document.getElementById('modal-overlay').classList.remove('hidden');
  } catch (err) {
    toast(`Cannot connect to ${item.media_type === 'tv' ? 'Sonarr' : 'Radarr'}: ` + err.message);
  }
}

document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal-overlay').classList.add('hidden');
  pendingItem = null;
});

document.getElementById('modal-confirm').addEventListener('click', async () => {
  if (!pendingItem) return;
  const qualityProfileId = document.getElementById('modal-quality').value;
  const rootFolderPath = document.getElementById('modal-folder').value;
  const isTv = pendingItem.media_type === 'tv';

  document.getElementById('modal-overlay').classList.add('hidden');
  setLoading(true);

  try {
    const endpoint = isTv ? '/api/sonarr/add' : '/api/radarr/add';
    const body = isTv
      ? { tvdbId: pendingItem.tvdb_id, title: pendingItem.title, qualityProfileId, rootFolderPath }
      : { tmdbId: pendingItem.id, title: pendingItem.title, qualityProfileId, rootFolderPath,
          year: pendingItem.release_date ? parseInt(pendingItem.release_date.slice(0, 4)) : undefined };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    const service = isTv ? 'Sonarr' : 'Radarr';
    toast(`"${pendingItem.title}" added to ${service}!`);
    markBtn(pendingItem.id, `In ${service}`, 'exists');
  } catch (err) {
    toast('Failed: ' + err.message);
  } finally {
    setLoading(false);
    pendingItem = null;
  }
});

// ── Mode toggle ───────────────────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === currentMode) return;
    currentMode = btn.dataset.mode;
    currentList = TABS[currentMode][0].list;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderTabs();
    loadFeed(true);
  });
});

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer = null;

document.getElementById('search-btn').addEventListener('click', () => {
  document.getElementById('search-overlay').classList.remove('hidden');
  document.getElementById('search-input').focus();
});

document.getElementById('search-close').addEventListener('click', closeSearch);

function closeSearch() {
  document.getElementById('search-overlay').classList.add('hidden');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
}

document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => doSearch(q), 420);
});

async function doSearch(q) {
  try {
    const endpoint = currentMode === 'tv'
      ? `/api/shows/search?q=${encodeURIComponent(q)}`
      : `/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch {}
}

function renderSearchResults(items) {
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p style="color:#888;text-align:center;padding:20px">No results</p>';
    return;
  }
  items.forEach((item) => {
    const isTv = item.media_type === 'tv';
    const card = document.createElement('div');
    card.className = 'search-card';
    card.innerHTML = `
      <img class="search-poster" src="${item.poster_path || ''}" alt="" loading="lazy" onerror="this.style.background='#222';this.src=''" />
      <div class="search-info">
        <h3>${item.title}</h3>
        <p>${item.overview || ''}</p>
      </div>
      <button class="search-add-btn ${isTv ? 'sonarr' : ''}" data-tmdb-id="${item.id}" data-media-type="${item.media_type || 'movie'}">
        + ${isTv ? 'Sonarr' : 'Radarr'}
      </button>
    `;

    card.querySelector('.search-info').addEventListener('click', () => {
      if (!item.youtube_key) { toast('No trailer available'); return; }
      closeSearch();
      injectItem(item);
    });

    card.querySelector('.search-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(item);
    });

    container.appendChild(card);
  });

  checkStatusBatch(items);
}

// ── Inject item at top of feed ────────────────────────────────────────────────
function injectItem(item) {
  itemCache.unshift(item);

  const wrapper = document.getElementById('swiper-wrapper');
  Array.from(wrapper.querySelectorAll('.swiper-slide')).forEach((slide, i) => {
    const newIdx = i + 1;
    slide.dataset.index = newIdx;
    const vwrap  = slide.querySelector('[id^="vwrap-"]');
    const ytDiv  = slide.querySelector('[id^="yt-"]:not(.yt-facade)');
    const facade = slide.querySelector('[id^="yt-facade-"]');
    const shield = slide.querySelector('[id^="shield-"]');
    if (vwrap)  vwrap.id  = `vwrap-${newIdx}`;
    if (ytDiv)  ytDiv.id  = `yt-${newIdx}`;
    if (facade) facade.id = `yt-facade-${newIdx}`;
    if (shield) shield.id = `shield-${newIdx}`;
  });

  const newPlayers = {};
  const newReady = {};
  Object.keys(players).forEach((k) => {
    newPlayers[parseInt(k) + 1] = players[k];
    newReady[parseInt(k) + 1] = playerReady[k];
  });
  players = newPlayers;
  playerReady = newReady;

  const newSlide = buildSlide(item, 0);
  wrapper.prepend(newSlide);

  swiper.update();
  swiper.slideTo(0, 0);
  ensurePlayer(item, 0);
  setTimeout(() => autoPlaySlide(0), 600);
}

// ── SSR hydration ─────────────────────────────────────────────────────────────
function hydrateInitial(payload) {
  totalPages = payload.total_pages || 1;
  // Server gave us page 1; next fetch should continue from page 2 (but we also
  // randomize start later on true resets).
  currentPage = 2;

  const filtered = (payload.results || []).filter((item) =>
    !watchedSet.has(watchedKey(item.id, item.media_type)) &&
    Math.random() >= skipProbability(item.id)
  );
  const list = shuffle([...filtered]);
  itemCache.push(...list);

  const wrapper = document.getElementById('swiper-wrapper');
  list.forEach((item, i) => wrapper.appendChild(buildSlide(item, i)));

  if (!swiper) initSwiper();

  statusAbortController = new AbortController();
  checkStatusBatch(list, statusAbortController.signal);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(function boot() {
  renderTabs();

  // Hydrate watched from SSR if present (saves one round trip).
  const preWatched = window.__INITIAL_WATCHED__;
  if (Array.isArray(preWatched)) {
    watchedSet = new Set(preWatched.map((r) => watchedKey(r.tmdb_id, r.media_type)));
  }

  const initialFeed = window.__INITIAL_FEED__;
  if (initialFeed && Array.isArray(initialFeed.results) && initialFeed.results.length) {
    if (!Array.isArray(preWatched)) loadWatched();
    hydrateInitial(initialFeed);
  } else {
    // No SSR data (TMDB not configured, or SSR raced past its deadline) —
    // fall back to client fetch.
    loadWatched().then(() => loadFeed(true));
  }
})();
