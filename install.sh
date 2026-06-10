#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Prefer reproducible installs; fall back to `npm install` if there is no lockfile.
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run install:cursor
