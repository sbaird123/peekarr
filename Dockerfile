FROM node:20-alpine AS deps

WORKDIR /build

# better-sqlite3 needs native build tools
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev


FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="Peekarr"
LABEL org.opencontainers.image.description="A TikTok-style trailer browser for Radarr/Sonarr"
LABEL org.opencontainers.image.source="https://github.com/yourusername/peekarr"

RUN apk add --no-cache tini wget \
    && addgroup -g 1000 peekarr \
    && adduser -u 1000 -G peekarr -s /bin/sh -D peekarr

WORKDIR /app

COPY --from=deps /build/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY public ./public

RUN mkdir -p /config && chown -R peekarr:peekarr /config /app

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=3000

VOLUME ["/config"]
EXPOSE 3000

USER peekarr

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
