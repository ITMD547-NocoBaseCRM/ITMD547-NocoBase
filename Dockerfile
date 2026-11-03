# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_OPTIONS=--max-old-space-size=1536

COPY package.json yarn.lock lerna.json .env.e2e.example ./
COPY tsconfig.json tsconfig.paths.json tsconfig.server.json ./
COPY packages ./packages

# The cache mount persists yarn's download cache across image builds on the same
# host, so rebuilds install from local disk instead of re-downloading every package.
RUN --mount=type=cache,target=/tmp/yarn-cache \
    yarn install --frozen-lockfile --production=false --link-duplicates --cache-folder /tmp/yarn-cache \
    && yarn build

ENV NODE_ENV=production
ENV APP_ENV=production
ENV APP_PORT=13000

EXPOSE 13000

CMD ["yarn", "start"]
