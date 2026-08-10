#!/usr/bin/env bash
# Codex-QQ-Skin launcher for macOS / Linux
set -e
PORT=8080
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 not found. Install it and retry."
  exit 1
fi

if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "Server already running on port $PORT."
else
  python3 server.py &
  sleep 2
fi

xdg-open "http://127.0.0.1:$PORT/index.html" 2>/dev/null \
  || open "http://127.0.0.1:$PORT/index.html" 2>/dev/null \
  || echo "Open http://127.0.0.1:$PORT/index.html in your browser"
