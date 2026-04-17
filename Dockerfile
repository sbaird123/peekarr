FROM node:20-alpine AS deps

WORKDIR /build

# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev


FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="Peekarr"
LABEL org.opencontainers.image.description="A TikTok-style trailer browser for Radarr/Sonarr"
LABEL org.opencontainers.image.source="https://github.com/sbaird123/peekarr"

# tini = PID 1 signal handling, su-exec = privilege drop, shadow = usermod/groupmod
RUN apk add --no-cache tini wget su-exec shadow

WORKDIR /app

COPY --from=deps /build/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /config

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=3000 \
    PUID=1000 \
    PGID=1000

VOLUME ["/config"]
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

# Entrypoint runs as root briefly to fix perms + set uid/gid, then su-exec's
# down to the unprivileged `node` user for the rest of the process lifetime.
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
