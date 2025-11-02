# ---------- Builder ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable pnpm via corepack (run as root)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Prevent Puppeteer from downloading its bundled Chromium during install
ENV PUPPETEER_SKIP_DOWNLOAD=1

COPY package.json pnpm-lock.yaml .npmrc tsconfig.json ./
RUN pnpm install --no-frozen-lockfile

COPY src ./src

RUN pnpm run build
# Keep only production dependencies for the runtime image
RUN pnpm prune --prod

# ---------- Runtime ----------
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-ipafont-gothic \
        fonts-wqy-zenhei \
        fonts-thai-tlwg \
        fonts-kacst \
        fonts-freefont-ttf \
        libxss1 \
        zstd \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r jina \
    && useradd -g jina -G audio,video -m jina

WORKDIR /app

# Only copy production node_modules and built output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY package.json ./

# Point Puppeteer to system Chromium
ENV OVERRIDE_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV PORT=8080

RUN chown -R jina:jina /app

EXPOSE 8080
USER jina
ENTRYPOINT ["node"]
CMD ["build/simple.js"]
