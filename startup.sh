#!/bin/bash
# Azure Web App startup script for NocoBase
set -e
cd /home/site/wwwroot
corepack enable 2>/dev/null || true

echo "Running NocoBase install (idempotent, safe to re-run on an already-installed app)..."
yarn nocobase install

echo "Starting NocoBase..."
yarn dev
