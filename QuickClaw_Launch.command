#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"; INSTALL_DIR="$SCRIPT_DIR/openclaw"; DASHBOARD_DIR="$SCRIPT_DIR/dashboard-files"; PID_DIR="$SCRIPT_DIR/.pids"; LOG_DIR="$SCRIPT_DIR/logs"; mkdir -p "$PID_DIR" "$LOG_DIR"
for n in gateway dashboard; do [[ -f "$PID_DIR/$n.pid" ]] && { p=$(cat "$PID_DIR/$n.pid" || true); kill -0 "$p" 2>/dev/null || rm -f "$PID_DIR/$n.pid"; }; done
if [[ ! -f "$PID_DIR/gateway.pid" ]] || ! kill -0 "$(cat "$PID_DIR/gateway.pid")" 2>/dev/null; then cd "$INSTALL_DIR"; GW_LOG="$LOG_DIR/gateway.log"; if [[ -x "$INSTALL_DIR/node_modules/.bin/open-claw" ]]; then nohup "$INSTALL_DIR/node_modules/.bin/open-claw" gateway start >> "$GW_LOG" 2>&1 & elif [[ -x "$INSTALL_DIR/node_modules/.bin/openclaw" ]]; then nohup "$INSTALL_DIR/node_modules/.bin/openclaw" gateway start >> "$GW_LOG" 2>&1 & else nohup npx open-claw gateway start >> "$GW_LOG" 2>&1 & fi; echo $! > "$PID_DIR/gateway.pid"; fi
DB_PORT=3000; PORT_PID=$(lsof -ti tcp:$DB_PORT 2>/dev/null | head -n1 || true)
if [[ -n "$PORT_PID" ]]; then CMD=$(ps -p "$PORT_PID" -o command= 2>/dev/null || true); if [[ "$CMD" == *"dashboard-files/server.js"* || "$CMD" == *"node server.js"* ]]; then echo "$PORT_PID" > "$PID_DIR/dashboard.pid"; else DB_PORT=3001; fi; fi
if [[ ! -f "$PID_DIR/dashboard.pid" ]] || ! kill -0 "$(cat "$PID_DIR/dashboard.pid")" 2>/dev/null; then cd "$DASHBOARD_DIR"; DB_LOG="$LOG_DIR/dashboard.log"; QUICKCLAW_ROOT="$SCRIPT_DIR" DASHBOARD_PORT="$DB_PORT" nohup node server.js >> "$DB_LOG" 2>&1 & echo $! > "$PID_DIR/dashboard.pid"; fi
echo "Dashboard: http://localhost:$DB_PORT"; echo "Gateway: http://localhost:5000"
