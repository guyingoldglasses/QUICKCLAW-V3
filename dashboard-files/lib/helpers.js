/**
 * helpers.js — Shared utility functions and constants
 */
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.DASHBOARD_PORT || 3000;
const HOME = process.env.HOME || os.homedir();
const ROOT = process.env.QUICKCLAW_ROOT || path.resolve(__dirname, '..', '..');
const PID_DIR = path.join(ROOT, '.pids');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'dashboard-data');
const INSTALL_DIR = path.join(ROOT, 'openclaw');
const CONFIG_PATH = path.join(INSTALL_DIR, 'config', 'default.yaml');
const LOCAL_OPENCLAW = path.join(INSTALL_DIR, 'node_modules', '.bin', 'openclaw');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const SKILLS_PATH = path.join(DATA_DIR, 'skills.json');
const CONFIG_BACKUPS_DIR = path.join(DATA_DIR, 'config-backups');
const ANTFARM_RUNS_PATH = path.join(DATA_DIR, 'antfarm-runs.json');
const CHAT_HISTORY_PATH = path.join(DATA_DIR, 'chat-history.json');
const PROFILE_ENV_PATH = path.join(DATA_DIR, 'profile-env.json');
const NEWS_FILE = path.join(DATA_DIR, 'news-cache.json');
const NEWS_PREFS_FILE = path.join(DATA_DIR, 'news-prefs.json');
const VERSIONS_DIR = path.join(DATA_DIR, '.versions');

// Ensure directories exist
for (const d of [PID_DIR, LOG_DIR, DATA_DIR, CONFIG_BACKUPS_DIR, VERSIONS_DIR])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// ═══ Shell command helpers ═══
function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf-8', timeout: opts.timeout || 15000, env: { ...process.env, ...opts.env }, ...opts }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: String(stdout || '').trim(), stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : null });
    });
  });
}
function runSync(cmd, opts = {}) {
  try { return { ok: true, output: execSync(cmd, { encoding: 'utf-8', timeout: opts.timeout || 15000, env: { ...process.env, ...opts.env }, ...opts }).trim() }; }
  catch (e) { return { ok: false, output: (e.stderr?.toString().trim() || '') + '\n' + (e.stdout?.toString().trim() || '') }; }
}
function portListeningSync(port) { try { execSync(`lsof -ti tcp:${port}`, { stdio: 'pipe' }); return true; } catch { return false; } }

// ═══ File helpers ═══
function tailFile(logFile, lines = 120) {
  const p = path.join(LOG_DIR, logFile);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').split('\n').slice(-Math.max(lines, 1)).join('\n');
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return typeof fallback === 'function' ? fallback() : fallback; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
function readEnv(fp) {
  try {
    const v = {};
    fs.readFileSync(fp, 'utf-8').split('\n').forEach(l => {
      l = l.trim(); if (!l || l[0] === '#') return;
      const eq = l.indexOf('='); if (eq < 1) return;
      let val = l.slice(eq + 1).trim();
      if ((val[0] === '"' && val.slice(-1) === '"') || (val[0] === "'" && val.slice(-1) === "'")) val = val.slice(1, -1);
      v[l.slice(0, eq).trim()] = val;
    });
    return v;
  } catch { return {}; }
}
function writeEnv(fp, v) { fs.writeFileSync(fp, Object.entries(v).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); }
function maskKey(k) { return (!k || k.length < 8) ? '••••••••' : k.slice(0, 6) + '••••' + k.slice(-4); }
function cleanCli(s) { return (s || '').replace(/.*ExperimentalWarning.*\n?/g, '').replace(/.*🦞.*\n?/g, '').replace(/\(Use `node.*\n?/g, '').replace(/.*OpenAI-compatible.*\n?/g, '').trim(); }

function cliBin() { return fs.existsSync(LOCAL_OPENCLAW) ? `"${LOCAL_OPENCLAW}"` : 'npx openclaw'; }
function gatewayStartCommand() { return `${cliBin()} gateway start --allow-unconfigured`; }
function gatewayStopCommand() { return `${cliBin()} gateway stop`; }

function ensureWithinRoot(rawPath) {
  const resolved = path.resolve(rawPath);
  const base = path.resolve(ROOT);
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  throw new Error('Path outside QuickClaw root is not allowed');
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function makePkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ═══ Gateway state ═══
async function gatewayState() {
  const ws18789 = portListeningSync(18789);
  const ws5000 = portListeningSync(5000);
  const status = await run(`${cliBin()} gateway status`, { cwd: INSTALL_DIR });
  const txt = `${status.stdout}\n${status.stderr}`;
  const looksRunning = /Runtime:\s*running|listening on ws:\/\/127\.0\.0\.1:18789|gateway\s+running/i.test(txt);
  return { running: ws18789 || ws5000 || looksRunning, ws18789, port5000: ws5000, statusText: txt.trim() };
}

module.exports = {
  PORT, HOME, ROOT, PID_DIR, LOG_DIR, DATA_DIR, INSTALL_DIR, CONFIG_PATH, LOCAL_OPENCLAW,
  PROFILES_PATH, SETTINGS_PATH, SKILLS_PATH, CONFIG_BACKUPS_DIR, ANTFARM_RUNS_PATH,
  CHAT_HISTORY_PATH, PROFILE_ENV_PATH, NEWS_FILE, NEWS_PREFS_FILE, VERSIONS_DIR,
  run, runSync, portListeningSync, tailFile, readJson, writeJson, readEnv, writeEnv,
  maskKey, cleanCli, cliBin, gatewayStartCommand, gatewayStopCommand,
  ensureWithinRoot, b64url, makePkcePair, gatewayState
};
