# Knowledge-scraper Cloud Run Job. Multi-stage: compile TS, then a lean runtime
# image that includes `git` (for shallow repo clones) + CA certs (HTTPS fetch).

FROM node:20-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:20-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
