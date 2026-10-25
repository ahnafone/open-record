# Open Record download server.
# Build from the repository root:  docker build -f apps/server/Dockerfile -t open-record-server .

# ---- build: bundle the server with esbuild (only esbuild is needed, not the whole monorepo) ----
FROM node:24-slim AS build
# Keep in sync with the root package.json devDependency.
ARG ESBUILD_VERSION=0.28.2
WORKDIR /repo
RUN npm install --no-save --no-package-lock --no-audit --no-fund "esbuild@${ESBUILD_VERSION}"
COPY package.json tsconfig.base.json ./
COPY apps/server ./apps/server
COPY libs/models ./libs/models
RUN node apps/server/build.mjs

# ---- runtime: node + yt-dlp (pinned), non-root ----
FROM node:24-slim AS runtime

# Bump to update yt-dlp (see apps/server/README.md).
ARG YTDLP_VERSION=2026.10.21

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tini \
  && python3 -m venv /opt/yt-dlp \
  && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" \
  && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
  && apt-get purge -y python3-venv && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /repo/dist/apps/server ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && useradd --system --uid 10001 --create-home openrecord

# /data holds the generated access token (see OPEN_RECORD_DATA_DIR). Owned by
# the runtime user so a fresh named volume is writable.
RUN mkdir -p /data && chown 10001:10001 /data

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    XDG_CACHE_HOME=/tmp/.cache \
    OPEN_RECORD_DATA_DIR=/data

USER openrecord
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "main.mjs"]
