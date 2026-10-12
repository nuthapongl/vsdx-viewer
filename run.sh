#!/usr/bin/env bash
# Run the VSDX Viewer & Editor on your own machine. Nothing is uploaded: it all stays local.
#
#   ./run.sh            install what is missing, start the dev server, open the browser
#   ./run.sh build      build the production version and serve it (http://localhost:4173)
#   ./run.sh check      type-check, lint and run the tests
#   ./run.sh help
#
# Needs Node.js 20 or newer (https://nodejs.org). Stop the server with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")"

mode="${1:-dev}"

if [[ "$mode" == "help" || "$mode" == "-h" || "$mode" == "--help" ]]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org (version 20 or newer), then run this again." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if (( major < 20 )); then
  echo "Node.js $(node -v) is too old: version 20 or newer is needed." >&2
  exit 1
fi

# Install the packages the first time, or when package.json / the lock file changed.
stamp="node_modules/.install-stamp"
if [[ ! -d node_modules || ! -f "$stamp" || package.json -nt "$stamp" || package-lock.json -nt "$stamp" ]]; then
  echo "Installing packages (first run, or they changed)..."
  npm install --no-audit --no-fund
  touch "$stamp"
fi

case "$mode" in
  dev)
    echo "Starting the dev server - the browser opens by itself. Stop with Ctrl+C."
    exec npx vite --open
    ;;
  build)
    npm run build
    echo "Serving the production build - the browser opens by itself. Stop with Ctrl+C."
    exec npx vite preview --open
    ;;
  check)
    npx tsc -b
    npx oxlint
    npx vitest run
    echo "All checks passed."
    ;;
  *)
    echo "Unknown option '$mode'. Use: ./run.sh [dev|build|check|help]" >&2
    exit 2
    ;;
esac
