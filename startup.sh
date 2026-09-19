#!/bin/bash
# Azure Web App startup script for NocoBase
set -e
cd /home/site/wwwroot

# A prior deployment ran with ENABLE_ORYX_BUILD=true, which left an
# oryx-manifest.toml and node_modules.tar.gz here. /home persists across
# deployments and restarts, so the platform's startup wrapper (which runs
# before this script, on every container boot) keeps finding that manifest
# and re-extracting the stale tarball over the correctly-deployed
# node_modules, breaking `nocobase-v1`. Removing them here means the next
# boot's wrapper won't find a manifest to act on. This boot may still be
# broken if they were present when the wrapper ran just now - the fix
# takes effect starting with the restart after this one.
rm -f oryx-manifest.toml node_modules.tar.gz

corepack enable 2>/dev/null || true

echo "Running NocoBase install (idempotent, safe to re-run on an already-installed app)..."
yarn nocobase install

echo "Starting NocoBase..."
yarn dev
