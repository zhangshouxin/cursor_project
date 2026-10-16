#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  npm install
fi
set -a
source .env
set +a
exec node server.js
