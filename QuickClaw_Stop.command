#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_DIR="$SCRIPT_DIR/.pids"

stop_pid_file() {
  local name="$1"
  local file="$PID_DIR/$name.pid"
  [[ -f "$file" ]] || return 0

  local pid
  pid=$(cat "$file" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "[info] Stopping $name (PID $pid)"
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$file"
}

stop_pid_file gateway
stop_pid_file dashboard

# Orphan cleanup: kill old local dashboard listeners left behind
for port in 3000 3001; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  [[ -z "$pids" ]] && continue
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if [[ "$cmd" == *"dashboard-files/server.js"* || "$cmd" == *"node server.js"* ]]; then
      echo "[info] Cleaning orphan dashboard on :$port (PID $pid)"
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
done

echo "Stopped."
