#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; PID_DIR="$SCRIPT_DIR/.pids"
for n in gateway dashboard; do f="$PID_DIR/$n.pid"; [[ -f "$f" ]] || continue; p=$(cat "$f" || true); kill "$p" 2>/dev/null || true; sleep 1; kill -9 "$p" 2>/dev/null || true; rm -f "$f"; done
echo "Stopped."
