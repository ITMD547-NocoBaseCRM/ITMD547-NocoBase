FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_OPTIONS=--max-old-space-size=1536

COPY package.json yarn.lock lerna.json .yarnrc .env.e2e.example ./
COPY tsconfig.json tsconfig.paths.json tsconfig.server.json ./
COPY packages ./packages

RUN yarn install --frozen-lockfile --production=false --link-duplicates --cache-folder /tmp/yarn-cache \
    && yarn build \
    && rm -rf /tmp/yarn-cache

ENV NODE_ENV=production
ENV APP_ENV=production
ENV APP_PORT=13000

EXPOSE 13000

CMD ["yarn", "start"]
