#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$SCRIPT_DIR/openclaw"
DASHBOARD_DIR="$SCRIPT_DIR/dashboard-files"
PID_DIR="$SCRIPT_DIR/.pids"
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

# Clean stale PID files
for n in gateway dashboard; do
  if [[ -f "$PID_DIR/$n.pid" ]]; then
    p=$(cat "$PID_DIR/$n.pid" || true)
    kill -0 "$p" 2>/dev/null || rm -f "$PID_DIR/$n.pid"
  fi
done

# Start gateway if needed
if [[ ! -f "$PID_DIR/gateway.pid" ]] || ! kill -0 "$(cat "$PID_DIR/gateway.pid")" 2>/dev/null; then
  cd "$INSTALL_DIR"
  GW_LOG="$LOG_DIR/gateway.log"

  if [[ -x "$INSTALL_DIR/node_modules/.bin/open-claw" ]]; then
    nohup "$INSTALL_DIR/node_modules/.bin/open-claw" gateway start >> "$GW_LOG" 2>&1 &
  elif [[ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]]; then
    nohup "$INSTALL_DIR/node_modules/.bin/openclaw" gateway start >> "$GW_LOG" 2>&1 &
  else
    nohup npx open-claw gateway start >> "$GW_LOG" 2>&1 &
  fi

  echo $! > "$PID_DIR/gateway.pid"
fi

# Dashboard port handling
DB_PORT=3000
PORT_PID=$(lsof -ti tcp:$DB_PORT 2>/dev/null | head -n1 || true)

if [[ -n "$PORT_PID" ]]; then
  CMD=$(ps -p "$PORT_PID" -o command= 2>/dev/null || true)
  if [[ "$CMD" == *"dashboard-files/server.js"* || "$CMD" == *"node server.js"* ]]; then
    echo "$PORT_PID" > "$PID_DIR/dashboard.pid"
    echo "[info] Reusing dashboard on :$DB_PORT (PID $PORT_PID)"
  else
    DB_PORT=3001
    echo "[warn] Port 3000 busy by another app. Using :$DB_PORT"
  fi
fi

# Start dashboard if needed
if [[ ! -f "$PID_DIR/dashboard.pid" ]] || ! kill -0 "$(cat "$PID_DIR/dashboard.pid")" 2>/dev/null; then
  cd "$DASHBOARD_DIR"
  DB_LOG="$LOG_DIR/dashboard.log"
  QUICKCLAW_ROOT="$SCRIPT_DIR" DASHBOARD_PORT="$DB_PORT" nohup node server.js >> "$DB_LOG" 2>&1 &
  echo $! > "$PID_DIR/dashboard.pid"
fi

GATEWAY_PID=$(cat "$PID_DIR/gateway.pid" 2>/dev/null || echo "unknown")
DASHBOARD_PID=$(cat "$PID_DIR/dashboard.pid" 2>/dev/null || echo "unknown")

echo ""
echo "QuickClaw V3 is ready"
echo "Gateway   : http://localhost:5000 (PID $GATEWAY_PID)"
echo "Dashboard : http://localhost:$DB_PORT (PID $DASHBOARD_PID)"
echo "Logs      : $LOG_DIR"

# Auto-open dashboard in browser (macOS)
open "http://localhost:$DB_PORT" 2>/dev/null || true
