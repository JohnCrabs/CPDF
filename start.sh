#!/usr/bin/env sh
# CPDF — start the local server on macOS / Linux and open the browser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js was not found."
  echo "  Install it from https://nodejs.org and run this script again."
  echo ""
  exit 1
fi

exec node server.js 8000 --open
