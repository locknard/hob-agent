FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ENV NODE_ENV=production \
    HOB_DATA_DIR=/data \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# Install the same workspace dependencies used by `pnpm start`; the source
# entrypoint remains TypeScript so container and bare-process capability sets
# stay identical.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY scripts/install-git-hooks.sh scripts/install-git-hooks.sh
COPY contracts/package.json contracts/package.json
COPY packages/agent-layer/package.json packages/agent-layer/package.json
COPY packages/hub/package.json packages/hub/package.json
COPY packages/inbox-web/package.json packages/inbox-web/package.json
RUN corepack enable pnpm \
    && corepack install --global pnpm@10.0.0 \
    && pnpm install --frozen-lockfile --prod=false

COPY contracts ./contracts
COPY packages ./packages

RUN mkdir -p /data \
    && chown -R node:node /app /data

EXPOSE 8787
STOPSIGNAL SIGTERM
VOLUME ["/data"]
USER node

# Keep Node as PID 1 so process-entry.ts receives SIGTERM/SIGINT directly.
ENTRYPOINT ["node", "--import", "tsx/esm", "packages/hub/src/main.ts"]
