#!/bin/bash
set -e
SCRIPT_DIR_ORIG="$(cd "$(dirname "$0")" && pwd)"
EXT=(); i=1
echo "Choose install location:"
for v in /Volumes/*/; do n=$(basename "$v"); case "$n" in "Macintosh HD"|"Macintosh HD - Data"|"Recovery"|"Preboot"|"VM"|"Update"|com.apple*) continue;; esac; [[ -w "$v" ]] || continue; EXT+=("$v"); echo "  $i) $n"; i=$((i+1)); done
echo "  $i) Current folder"
read -p "Choose [${i}]: " ch; ch=${ch:-$i}
if [[ "$ch" == "$i" ]]; then BASE_DIR="$SCRIPT_DIR_ORIG"; else idx=$((ch-1)); BASE_DIR="${EXT[$idx]}QuickClaw"; mkdir -p "$BASE_DIR"; cp "$SCRIPT_DIR_ORIG"/*.command "$BASE_DIR" 2>/dev/null || true; cp "$SCRIPT_DIR_ORIG"/START_HERE.html "$BASE_DIR" 2>/dev/null || true; cp "$SCRIPT_DIR_ORIG"/README.md "$BASE_DIR" 2>/dev/null || true; cp -R "$SCRIPT_DIR_ORIG"/dashboard-files "$BASE_DIR" 2>/dev/null || true; chmod +x "$BASE_DIR"/*.command 2>/dev/null || true; xattr -dr com.apple.quarantine "$BASE_DIR" 2>/dev/null || true; fi
INSTALL_DIR="$BASE_DIR/openclaw"; DASHBOARD_DIR="$BASE_DIR/dashboard-files"; LOG_DIR="$BASE_DIR/logs"; mkdir -p "$INSTALL_DIR" "$LOG_DIR"
echo "$BASE_DIR" > "$BASE_DIR/.quickclaw-root"; [[ "$BASE_DIR" != "$SCRIPT_DIR_ORIG" ]] && echo "$BASE_DIR" > "$SCRIPT_DIR_ORIG/.quickclaw-root"
[[ -f /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)"
command -v brew >/dev/null || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
command -v node >/dev/null || brew install node
cd "$INSTALL_DIR"
[[ -f package.json ]] || echo '{"name":"quickclaw-v3-openclaw","private":true,"dependencies":{}}' > package.json
npm install --no-fund --no-audit openclaw || true
mkdir -p "$INSTALL_DIR/config"; [[ -f "$INSTALL_DIR/config/default.yaml" ]] || cat > "$INSTALL_DIR/config/default.yaml" <<'YAML'
gateway:
  port: 5000
  host: 0.0.0.0
YAML
cd "$DASHBOARD_DIR"; [[ -f package.json ]] || echo '{"name":"quickclaw-v3-dashboard","private":true,"scripts":{"start":"node server.js"},"dependencies":{"express":"^4.18.2"}}' > package.json; npm install --production --no-fund --no-audit
bash "$BASE_DIR/QuickClaw_Launch.command"
