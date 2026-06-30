# Knowledge-scraper Cloud Run Job. Multi-stage: compile TS, then a lean runtime
# image that includes `git` (shallow repo clones), CA certs (HTTPS fetch), and a
# headless Chromium (Playwright) for rendering JavaScript-rendered (SPA) pages.

FROM node:20-slim AS build
WORKDIR /app
# We only need types to compile; don't pull Chromium into the throwaway build image.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Browsers live in a world-readable shared path so the non-root `node` user can run
# Chromium that was installed here as root.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
# Install Chromium + its OS dependencies (needs root + apt; before USER node).
RUN apt-get update \
  && npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rx /ms-playwright
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
