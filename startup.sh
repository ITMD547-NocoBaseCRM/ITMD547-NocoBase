#!/bin/bash
# Azure Web App startup script for NocoBase
set -e
cd /home/site/wwwroot

# Azure App Service compresses node_modules into node_modules.tar.gz on
# every zip deploy and extracts it at container startup (a platform-level
# optimization, unrelated to ENABLE_ORYX_BUILD). That extraction does not
# preserve symlinks, so node_modules/.bin/nocobase(-v1) go missing every
# time, even though the real file they point to
# (node_modules/@nocobase/cli-v1/bin/index.js) survives intact. Calling
# the CLI directly isn't enough on its own: NocoBase's own `install`
# command shells back out via `yarn nocobase pkg download-pro`
# internally, which hits the same missing symlink. Recreate the bin
# symlinks so every nocobase invocation - ours and NocoBase's own
# internal ones - resolves normally.
mkdir -p node_modules/.bin
ln -sf ../@nocobase/cli-v1/bin/index.js node_modules/.bin/nocobase
ln -sf ../@nocobase/cli-v1/bin/index.js node_modules/.bin/nocobase-v1
chmod +x node_modules/@nocobase/cli-v1/bin/index.js

corepack enable 2>/dev/null || true

echo "Running NocoBase install (idempotent, safe to re-run on an already-installed app)..."
yarn nocobase install

echo "Starting NocoBase..."
yarn start
