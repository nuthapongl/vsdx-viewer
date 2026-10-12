#!/usr/bin/env bash
# macOS: double-click this file in Finder to start the app (it opens a Terminal window).
cd "$(dirname "$0")"
./run.sh "$@"
status=$?
echo
echo "The app stopped (exit code $status). You can close this window."
read -r -n 1 -s -p "Press any key to close..." || true
