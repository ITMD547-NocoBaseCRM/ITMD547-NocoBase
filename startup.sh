#!/bin/bash
# Azure Web App startup script for NocoBase
set -e
cd /home/site/wwwroot

# Azure App Service compresses node_modules into node_modules.tar.gz on
# every zip deploy and extracts it at container startup (this is a
# platform-level optimization, unrelated to ENABLE_ORYX_BUILD). That
# extraction does not preserve symlinks, so node_modules/.bin/nocobase-v1
# goes missing every time, even though the real file it points to
# (node_modules/@nocobase/cli-v1/bin/index.js) is intact. Invoke it
# directly instead of going through the missing bin symlink (via `yarn
# nocobase`/`yarn start`, both of which resolve to the same broken path).
NOCOBASE_CLI=node_modules/@nocobase/cli-v1/bin/index.js

corepack enable 2>/dev/null || true

echo "Running NocoBase install (idempotent, safe to re-run on an already-installed app)..."
node "$NOCOBASE_CLI" install

echo "Starting NocoBase..."
node "$NOCOBASE_CLI" start
