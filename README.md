# Peekarr

A TikTok-style trailer browser for **Radarr** and **Sonarr**. Peek at upcoming movies and trending shows, autoplay their trailers, and add the ones you like straight to your library with a tap.

Built to feel like any other *arr — drop it in your Docker stack, configure through the UI, done.

## Features

- Vertical swipe feed of YouTube trailers (TMDB source)
- **Movies** tab (Upcoming / Now Playing / Popular) and **TV** tab (Trending / Popular / On Air / Top Rated)
- One-tap **Add to Radarr / Sonarr** with quality profile + root folder selection
- Search bar for anything in TMDB
- Marks already-in-library entries so you don't re-add
- "Watched" list so you don't see the same trailers again
- Soft deprioritisation of trailers you keep skipping
- Config stored in a SQLite volume — no `.env` edits needed after install

## Install (Docker Compose)

```yaml
services:
  peekarr:
    image: ghcr.io/yourusername/peekarr:latest
    container_name: peekarr
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    restart: unless-stopped
```

Then:

```sh
docker compose up -d
```

Open <http://localhost:3000/settings> and plug in:

- **TMDB API key** (free from <https://www.themoviedb.org/settings/api>)
- **Radarr** URL + API key (Radarr → Settings → General → Security)
- **Sonarr** URL + API key (Sonarr → Settings → General → Security)

Hit **Test** next to each one, then **Save Changes**. Visit `/` and start swiping.

### Running in the same stack as Radarr/Sonarr

Use the Docker service name as the URL — e.g. `http://radarr:7878` and `http://sonarr:8989`. Make sure all containers share a Docker network.

## Build from source

```sh
git clone https://github.com/yourusername/peekarr
cd peekarr
docker build -t peekarr .
docker run -d --name peekarr -p 3000:3000 -v $(pwd)/config:/config peekarr
```

## Develop locally

```sh
npm install
cp .env.example .env    # optional — settings UI works without this
npm run dev
```

Runs on <http://localhost:3000>. Node 20+ required.

## Environment variables

Everything is optional — the Settings UI is the source of truth. Env vars only seed defaults on first run.

| Variable         | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `PORT`           | HTTP port (default `3000`)                                 |
| `CONFIG_DIR`     | Path for the SQLite DB (default `/config` in Docker)       |
| `TMDB_API_KEY`   | TMDB v3 API key                                            |
| `RADARR_URL`     | e.g. `http://radarr:7878`                                  |
| `RADARR_API_KEY` | Radarr API key                                             |
| `SONARR_URL`     | e.g. `http://sonarr:8989`                                  |
| `SONARR_API_KEY` | Sonarr API key                                             |

## Volume layout

```
/config/
  data.db        # settings, watched list
```

Back this up and you've backed up everything Peekarr knows.

## Gestures

- **Swipe up/down** — next / previous trailer
- **Single tap** — play / pause (and unmute)
- **Triple tap** — quick-add dialog
- **"+ Add"** / **"Watched"** / **"Skip"** buttons on each slide

## License

MIT
