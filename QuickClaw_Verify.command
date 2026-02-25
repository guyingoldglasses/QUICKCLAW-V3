#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -d "$SCRIPT_DIR/openclaw" ]] && echo "[OK] openclaw dir" || echo "[WARN] openclaw dir missing"
[[ -f "$SCRIPT_DIR/openclaw/config/default.yaml" ]] && echo "[OK] config" || echo "[WARN] config missing"
command -v node >/dev/null && echo "[OK] node $(node -v)" || echo "[WARN] node missing"
[[ -f "$SCRIPT_DIR/dashboard-files/server.js" ]] && echo "[OK] dashboard" || echo "[WARN] dashboard missing"
