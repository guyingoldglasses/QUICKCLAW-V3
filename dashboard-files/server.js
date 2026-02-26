/**
 * OpenClaw Command Center — QuickClaw Backend Server v2.5
 * Ported from VPS v2.5 with Mac/local adaptations:
 *   - Local process management (PID files) instead of systemd
 *   - External-drive friendly paths via QUICKCLAW_ROOT
 *   - No auth token required (localhost only)
 *   - macOS security checks instead of Linux server checks
 *   - Full feature parity: news, versions, security, usage, cron, OAuth PKCE
 */
const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');

const app = express();
const server = http.createServer(app);
const PORT = process.env.DASHBOARD_PORT || 3000;
const HOME = process.env.HOME || os.homedir();
const ROOT = process.env.QUICKCLAW_ROOT || path.resolve(__dirname, '..');
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

for (const d of [PID_DIR, LOG_DIR, DATA_DIR, CONFIG_BACKUPS_DIR, VERSIONS_DIR])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// ═══ MIDDLEWARE ═══
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ═══ UTILITY FUNCTIONS ═══
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

// ═══ PROFILE MANAGEMENT ═══
// QuickClaw stores profiles as an array in profiles.json
// Each profile maps to actual OpenClaw directories on disk
function getProfiles() {
  const list = readJson(PROFILES_PATH, null);
  if (Array.isArray(list) && list.length) return list;
  const starter = [{ id: 'default', name: 'Default', active: true, status: 'running', port: 3000, notes: '', soul: '', memoryPath: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
  writeJson(PROFILES_PATH, starter);
  return starter;
}
function saveProfiles(list) { writeJson(PROFILES_PATH, list); }

// Map a profile to filesystem paths (config dir, workspace, .env)
function profilePaths(profileId) {
  const ocDir = path.join(HOME, '.openclaw');
  const cbDir = path.join(HOME, '.clawdbot');
  // Default profile uses standard locations
  if (profileId === 'default') {
    const configDir = fs.existsSync(ocDir) ? ocDir : (fs.existsSync(cbDir) ? cbDir : ocDir);
    const workspace = fs.existsSync(path.join(HOME, 'clawd')) ? path.join(HOME, 'clawd') : ROOT;
    return { configDir, workspace, envPath: path.join(configDir, '.env'), configJson: path.join(configDir, 'clawdbot.json') };
  }
  // Other profiles use suffixed directories
  const suffix = '-' + profileId.replace(/^p-/, '');
  const configDir = fs.existsSync(ocDir + suffix) ? (ocDir + suffix) : (cbDir + suffix);
  const workspace = path.join(HOME, 'clawd' + suffix);
  return { configDir, workspace, envPath: path.join(configDir, '.env'), configJson: path.join(configDir, 'clawdbot.json') };
}

function profileEnvVars(p) {
  const pp = profilePaths(p.id || p);
  return { CLAWDBOT_CONFIG_DIR: pp.configDir, OPENCLAW_CONFIG_DIR: pp.configDir };
}

function findSoul(pp) {
  const cfg = readJson(pp.configJson, null);
  const paths = [];
  if (cfg?.soulFile) paths.push(path.resolve(pp.workspace, cfg.soulFile));
  paths.push(path.join(pp.workspace, 'soul.md'), path.join(pp.workspace, 'SOUL.md'), path.join(pp.configDir, 'soul.md'));
  for (const x of paths) if (fs.existsSync(x)) return x;
  return null;
}

function getSkillStates(pp) { return readJson(path.join(pp.workspace, '.skill-states.json'), {}); }
function saveSkillStates(pp, s) { writeJson(path.join(pp.workspace, '.skill-states.json'), s); }

// ═══ SETTINGS (QuickClaw-local config) ═══
function getSettings() {
  return readJson(SETTINGS_PATH, {
    openaiApiKey: '', openaiOAuthEnabled: false, anthropicApiKey: '',
    telegramBotToken: '', ftpHost: '', ftpUser: '', emailUser: ''
  });
}
function saveSettings(s) { writeJson(SETTINGS_PATH, { ...getSettings(), ...s }); }

// ═══ GATEWAY STATE ═══
async function gatewayState() {
  const ws18789 = portListeningSync(18789);
  const ws5000 = portListeningSync(5000);
  const status = await run(`${cliBin()} gateway status`, { cwd: INSTALL_DIR });
  const txt = `${status.stdout}\n${status.stderr}`;
  const looksRunning = /Runtime:\s*running|listening on ws:\/\/127\.0\.0\.1:18789|gateway\s+running/i.test(txt);
  return { running: ws18789 || ws5000 || looksRunning, ws18789, port5000: ws5000, statusText: txt.trim() };
}

// ═══ USAGE TRACKING — Ported from VPS v2.3 ═══
function findUsageLogs(pp) {
  const locations = [
    path.join(pp.workspace, 'memory', 'usage-log.json'),
    path.join(pp.workspace, 'memory', 'usage.json'),
    path.join(pp.workspace, '.usage-log.json'),
    path.join(pp.configDir, 'usage-log.json'),
    path.join(pp.configDir, 'agents', 'main', 'usage-log.json'),
  ];
  const memDir = path.join(pp.workspace, 'memory');
  try {
    if (fs.existsSync(memDir)) {
      fs.readdirSync(memDir).forEach(f => {
        if (f.match(/^usage[-_]?\d{4}/) && f.endsWith('.json')) locations.push(path.join(memDir, f));
      });
    }
  } catch {}
  return locations.filter(l => fs.existsSync(l));
}

function aggregateUsage(pp) {
  const files = findUsageLogs(pp);
  let tIn = 0, tOut = 0, tCost = 0;
  const byModel = {}, byDay = {}, sessions = [];
  let lastModified = null;

  files.forEach(fp => {
    const data = readJson(fp, null);
    if (!data) return;
    try { const stat = fs.statSync(fp); if (!lastModified || stat.mtime > lastModified) lastModified = stat.mtime; } catch {}
    const entries = data.entries || (Array.isArray(data) ? data : [data]);
    entries.forEach(e => {
      if (e.totals) {
        const dayKey = e.date || e.timestamp?.slice(0, 10) || 'unknown';
        if (!byDay[dayKey]) byDay[dayKey] = { date: dayKey, inputTokens: 0, outputTokens: 0, cost: 0, sessions: 0 };
        byDay[dayKey].inputTokens += e.totals.inputTokens || 0;
        byDay[dayKey].outputTokens += e.totals.outputTokens || 0;
        byDay[dayKey].cost += e.totals.estimatedCostUsd || 0;
        byDay[dayKey].sessions += e.sessions?.length || 0;
        tIn += e.totals.inputTokens || 0; tOut += e.totals.outputTokens || 0; tCost += e.totals.estimatedCostUsd || 0;
      }
      if (e.sessions) e.sessions.forEach(s => {
        const m = s.model || 'unknown';
        if (!byModel[m]) byModel[m] = { inputTokens: 0, outputTokens: 0, cost: 0, sessions: 0 };
        byModel[m].inputTokens += s.inputTokens || 0; byModel[m].outputTokens += s.outputTokens || 0;
        byModel[m].cost += s.estimatedCostUsd || 0; byModel[m].sessions++;
        sessions.push({ model: m, tokens: (s.inputTokens || 0) + (s.outputTokens || 0), cost: s.estimatedCostUsd || 0, timestamp: s.timestamp || e.date });
      });
    });
  });

  const dayList = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
  const daysTracked = dayList.length || 1;
  const avgDaily = tCost / daysTracked;
  return {
    totals: { inputTokens: tIn, outputTokens: tOut, estimatedCostUsd: Math.round(tCost * 10000) / 10000, totalTokens: tIn + tOut },
    byModel, byDay: dayList.slice(-30), daysTracked,
    avgDailyCost: Math.round(avgDaily * 10000) / 10000,
    projected30d: Math.round(avgDaily * 30 * 10000) / 10000,
    recentSessions: sessions.slice(-20).reverse(),
    sources: files.map(f => path.basename(f)),
    lastModified: lastModified ? lastModified.toISOString() : null,
    noData: files.length === 0
  };
}

// ═══ NEWS AGGREGATION — Ported from VPS v2.4 ═══
function loadNews() { return readJson(NEWS_FILE, { articles: [], lastFetched: null }); }
function saveNews(data) { writeJson(NEWS_FILE, data); }
function loadNewsPrefs() {
  return readJson(NEWS_PREFS_FILE, {
    quality: [], useless: [], bookmarks: [], deletedUrls: [],
    sources: { hn_ai: true, hn_openclaw: true, hn_agents: true, hn_llm: true, github: true, reddit_ai: true, arxiv: true, techcrunch: true },
    customSources: {}
  });
}
function saveNewsPrefs(p) { writeJson(NEWS_PREFS_FILE, p); }

function buildNewsSources(prefs, random) {
  const customSources = {};
  if (prefs?.sources) {
    Object.entries(prefs.sources).forEach(([k, v]) => {
      if (k.startsWith('custom_') && v && typeof v === 'object' && v.url) {
        const domain = v.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        customSources[k] = { name: v.name || domain, cmd: `curl -s "https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(domain)}&tags=story&hitsPerPage=8" 2>/dev/null`, type: 'hn' };
      }
    });
  }
  const ALL_SOURCES = {
    hn_ai: { name: 'HN: AI/ML', cmd: 'curl -s "https://hn.algolia.com/api/v1/search?query=open+source+AI+LLM&tags=story&hitsPerPage=15" 2>/dev/null', type: 'hn' },
    hn_openclaw: { name: 'HN: OpenClaw', cmd: 'curl -s "https://hn.algolia.com/api/v1/search?query=openclaw+OR+clawdbot&tags=story&hitsPerPage=12" 2>/dev/null', type: 'hn' },
    hn_agents: { name: 'HN: AI Agents', cmd: 'curl -s "https://hn.algolia.com/api/v1/search?query=AI+agents+autonomous+tool+use&tags=story&hitsPerPage=12" 2>/dev/null', type: 'hn' },
    hn_llm: { name: 'HN: LLM Dev', cmd: 'curl -s "https://hn.algolia.com/api/v1/search?query=LLM+development+fine+tuning+local&tags=story&hitsPerPage=12" 2>/dev/null', type: 'hn' },
    github: { name: 'GitHub Trending', cmd: 'curl -s "https://api.github.com/search/repositories?q=openclaw+OR+llm+agent+OR+open+source+ai&sort=updated&order=desc&per_page=12" 2>/dev/null', type: 'github' },
    reddit_ai: { name: 'Reddit: AI', cmd: 'curl -s "https://www.reddit.com/r/artificial+LocalLLaMA+MachineLearning/top.json?t=day&limit=12" 2>/dev/null', type: 'reddit' },
    arxiv: { name: 'arXiv: AI Papers', cmd: 'curl -s "http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=10" 2>/dev/null', type: 'arxiv' },
    techcrunch: { name: 'HN: TechCrunch AI', cmd: 'curl -s "https://hn.algolia.com/api/v1/search?query=AI+startup+funding&tags=story&hitsPerPage=10" 2>/dev/null', type: 'hn' },
  };
  const combined = Object.assign({}, ALL_SOURCES, customSources);
  if (random) return Object.entries(combined);
  const srcPrefs = prefs?.sources || {};
  return Object.entries(combined).filter(([k]) => srcPrefs[k] !== false);
}

// ═══ VERSION TIMELINE — Ported from VPS v2.1 ═══
function getVersions() {
  const meta = readJson(path.join(VERSIONS_DIR, 'versions.json'), null);
  if (meta) return meta;
  return { versions: [], current: null, baseStable: null };
}
function saveVersionsMeta(data) { writeJson(path.join(VERSIONS_DIR, 'versions.json'), data); }

// ═══ CONFIG FILE HELPERS ═══
function openclawConfigPath() {
  return path.join(HOME, '.openclaw', 'openclaw.json');
}
function writeOpenclawTelegramToken(token) {
  const p = openclawConfigPath();
  if (!fs.existsSync(p)) return { ok: false, error: `Config not found: ${p}` };
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.channels = cfg.channels || {};
  cfg.channels.telegram = cfg.channels.telegram || {};
  cfg.channels.telegram.botToken = token;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return { ok: true, path: p };
}

function backupCurrentConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(CONFIG_BACKUPS_DIR, `default-${stamp}.yaml`);
  fs.copyFileSync(CONFIG_PATH, dst);
  return dst;
}

function applySettingsToConfigFile() {
  const s = getSettings();
  const backup = backupCurrentConfig();
  const lines = ['# QuickClaw V3 generated config', 'gateway:', '  mode: local', '  port: 5000', '  host: 127.0.0.1', ''];
  if (s.openaiApiKey) lines.push('openai:', `  api_key: "${s.openaiApiKey}"`, '');
  if (s.anthropicApiKey) lines.push('anthropic:', `  api_key: "${s.anthropicApiKey}"`, '');
  if (s.telegramBotToken) lines.push('telegram:', `  bot_token: "${s.telegramBotToken}"`, '');
  if (s.ftpHost || s.ftpUser) lines.push('ftp:', ...(s.ftpHost ? [`  host: "${s.ftpHost}"`] : []), ...(s.ftpUser ? [`  user: "${s.ftpUser}"`] : []), '');
  if (s.emailUser) lines.push('email:', `  user: "${s.emailUser}"`, '');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'));
  return { path: CONFIG_PATH, backup };
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function makePkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ═══ SKILLS CATALOG (QuickClaw local) ═══
function defaultSkillsCatalog() {
  return [
    { id: 'core-tools', name: 'Core Platform Tools', description: 'Essential local runtime controls: gateway status/start/stop, logs, config read/write, profile storage.', includes: ['gateway controls', 'log viewer', 'config apply/backup', 'profile persistence'], enabled: true, installed: true, risk: 'low' },
    { id: 'openai-auth', name: 'OpenAI Authentication', description: 'Stores OpenAI credentials and OAuth mode flags for local config generation.', includes: ['api key field', 'oauth mode flag', 'settings export/import'], enabled: false, installed: true, risk: 'medium' },
    { id: 'ftp-deploy', name: 'FTP Deploy', description: 'Deployment helper settings for FTP host/user workflows.', includes: ['ftp host/user settings', 'future deploy hooks'], enabled: false, installed: false, risk: 'medium' },
    { id: 'telegram-setup', name: 'Telegram Setup', description: 'Easy BotFather token setup and quick-connect to config.', includes: ['token save', 'config apply', 'connection hints'], enabled: false, installed: false, risk: 'low' },
    { id: 'email', name: 'Email Integration', description: 'Email account settings for notifications and outbound workflows.', includes: ['email user settings', 'future send/read actions'], enabled: false, installed: false, risk: 'medium' },
    { id: 'antfarm', name: 'Antfarm Automation', description: 'Task queue + run history panel for workflow automations.', includes: ['run queue', 'recent runs', 'status panel'], enabled: false, installed: false, risk: 'medium' },
  ];
}
function getSkills() {
  const list = readJson(SKILLS_PATH, null);
  const defaults = defaultSkillsCatalog();
  if (Array.isArray(list)) {
    const byId = Object.fromEntries(defaults.map(s => [s.id, s]));
    const merged = list.map(s => ({ ...byId[s.id], ...s }));
    for (const d of defaults) if (!merged.find(x => x.id === d.id)) merged.push(d);
    return merged;
  }
  writeJson(SKILLS_PATH, defaults);
  return defaults;
}
function saveSkills(list) { writeJson(SKILLS_PATH, list); }

function getAntfarmRuns() { return readJson(ANTFARM_RUNS_PATH, []); }
function saveAntfarmRuns(runs) { writeJson(ANTFARM_RUNS_PATH, runs); }
function getChatHistory() { return readJson(CHAT_HISTORY_PATH, []); }
function saveChatHistory(rows) { writeJson(CHAT_HISTORY_PATH, rows); }

// Profile env store (QuickClaw local JSON-based .env equivalent)
function getProfileEnvStore() { return readJson(PROFILE_ENV_PATH, {}); }
function saveProfileEnvStore(store) { writeJson(PROFILE_ENV_PATH, store); }
function getProfileEnv(profileId) {
  const st = getProfileEnvStore();
  const raw = st[profileId] || {};
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object') cleaned[k] = String(v.value ?? '');
    else cleaned[k] = String(v ?? '');
  }
  return cleaned;
}

// ════════════════════════════════════════════
// ═══          API ENDPOINTS              ═══
// ════════════════════════════════════════════

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ═══ STATUS & SYSTEM ═══
app.get('/api/status', async (req, res) => {
  const gw = await gatewayState();
  res.json({
    gateway: gw,
    dashboard: { running: true, pid: process.pid, port: Number(PORT), port3000: portListeningSync(3000), port3001: portListeningSync(3001) },
    root: ROOT, installDir: INSTALL_DIR, configPath: CONFIG_PATH,
    configExists: fs.existsSync(CONFIG_PATH),
    addons: { openai: 'check-settings', anthropic: 'check-settings', telegram: 'check-settings', ftp: 'check-settings', email: 'check-settings' }
  });
});

app.get('/api/system', async (req, res) => {
  const gw = await gatewayState();
  const diskR = runSync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\" used)\"}'");
  const memR = runSync("vm_stat | awk '/Pages free/{free=$3}/Pages active/{active=$3}/Pages speculative/{spec=$3}END{total=free+active+spec; printf \"%.1fG\", (active*4096)/1073741824}'");
  const ocVer = runSync(`${cliBin()} --version 2>/dev/null`);
  res.json({
    hostname: os.hostname(), nodeVersion: process.version, platform: process.platform,
    uptime: `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
    diskUsage: diskR.output || 'unknown', memInfo: memR.output || `${Math.round(os.freemem() / 1073741824)}G free of ${Math.round(os.totalmem() / 1073741824)}G`,
    openclawVersion: cleanCli(ocVer.output) || 'not found',
    quickclawRoot: ROOT, installDir: INSTALL_DIR,
    gateway: { running: gw.running, ws18789: gw.ws18789, port5000: gw.port5000 },
    dashboardPort: PORT, profiles: getProfiles().length
  });
});

app.get('/api/system/storage', async (req, res) => {
  const profiles = {};
  for (const p of getProfiles()) {
    const pp = profilePaths(p.id);
    const cfgSize = runSync(`du -sh "${pp.configDir}" 2>/dev/null`).output?.split('\t')[0] || '0';
    const wsSize = runSync(`du -sh "${pp.workspace}" 2>/dev/null`).output?.split('\t')[0] || '0';
    profiles[p.id] = { configSize: cfgSize, workspaceSize: wsSize };
  }
  const total = runSync("df -h / | tail -1 | awk '{print $2}'").output || '?';
  const used = runSync("df -h / | tail -1 | awk '{print $3}'").output || '?';
  const avail = runSync("df -h / | tail -1 | awk '{print $4}'").output || '?';
  const pct = runSync("df -h / | tail -1 | awk '{print $5}'").output?.trim() || '?';
  res.json({ profiles, disk: { total, used, avail, pct }, trash: '0' });
});

// ═══ ACTIVITY FEED ═══
app.get('/api/activity', async (req, res) => {
  const gw = await gatewayState();
  const events = [];
  if (gw.running) events.push({ type: 'status', text: 'Gateway running', at: new Date().toISOString() });
  const gwTail = tailFile('gateway.log', 40).split('\n').filter(Boolean).slice(-8).map(t => ({ type: 'gateway-log', text: t }));
  const dbTail = tailFile('dashboard.log', 20).split('\n').filter(Boolean).slice(-5).map(t => ({ type: 'dashboard-log', text: t }));
  res.json({ events: [...events, ...gwTail, ...dbTail] });
});

// ═══ ALERTS ═══
app.get('/api/alerts', async (req, res) => {
  const alerts = [];
  const gw = await gatewayState();
  if (!gw.running) alerts.push({ type: 'warn', message: 'Gateway is not running', icon: '⚠️' });
  if (!fs.existsSync(CONFIG_PATH)) alerts.push({ type: 'warn', message: 'No config file found', icon: '📄' });
  const disk = runSync("df -h / | tail -1 | awk '{print $5}'").output?.replace('%', '').trim();
  if (parseInt(disk) > 85) alerts.push({ type: 'warn', message: `Disk usage at ${disk}%`, icon: '💾' });
  // Check if any profile has high cost
  let totalDayCost = 0;
  for (const p of getProfiles()) {
    const pp = profilePaths(p.id);
    const u = aggregateUsage(pp);
    if (u.byDay.length > 0) totalDayCost += u.byDay[u.byDay.length - 1].cost || 0;
  }
  if (totalDayCost > 1) alerts.push({ type: 'warn', message: `High daily API cost: $${totalDayCost.toFixed(2)}`, icon: '💰' });
  res.json({ alerts });
});

// ═══ LOGS ═══
app.get('/api/log/:name', (req, res) => {
  const name = req.params.name === 'gateway' ? 'gateway.log' : 'dashboard.log';
  const lines = parseInt(req.query.lines || '120', 10);
  res.type('text/plain').send(tailFile(name, lines));
});

// ═══ GATEWAY CONTROLS ═══
app.post('/api/gateway/start', async (req, res) => {
  const result = await run(`${gatewayStartCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: gw.running, message: gw.running ? 'gateway running' : 'gateway start attempted', result, gateway: gw });
});
app.post('/api/gateway/stop', async (req, res) => {
  const result = await run(`${gatewayStopCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: !gw.running, message: !gw.running ? 'gateway stopped' : 'gateway stop attempted', result, gateway: gw });
});
app.post('/api/gateway/restart', async (req, res) => {
  await run(`${gatewayStopCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  await run(`${gatewayStartCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: gw.running, message: gw.running ? 'gateway restarted' : 'gateway restart attempted', gateway: gw });
});

// ═══ CONFIG ═══
app.get('/api/config', (req, res) => {
  const exists = fs.existsSync(CONFIG_PATH);
  res.json({ exists, path: CONFIG_PATH, content: exists ? fs.readFileSync(CONFIG_PATH, 'utf8') : '' });
});
app.post('/api/settings/apply-config', (req, res) => {
  const out = applySettingsToConfigFile();
  res.json({ ok: true, message: 'Config regenerated from dashboard settings', ...out });
});
app.get('/api/config/backups', (req, res) => {
  const files = fs.readdirSync(CONFIG_BACKUPS_DIR).filter(f => f.endsWith('.yaml')).sort().reverse();
  res.json({ files });
});
app.post('/api/config/restore', (req, res) => {
  const file = req.body?.file;
  if (!file) return res.status(400).json({ ok: false, error: 'Missing file' });
  const src = path.join(CONFIG_BACKUPS_DIR, file);
  if (!fs.existsSync(src)) return res.status(404).json({ ok: false, error: 'Backup not found' });
  fs.copyFileSync(src, CONFIG_PATH);
  res.json({ ok: true, message: 'Config restored', file });
});

// ═══ PROFILES ═══
app.get('/api/profiles', (req, res) => {
  const profiles = getProfiles().map(p => {
    const pp = profilePaths(p.id);
    let skillCount = 0;
    try { if (fs.existsSync(path.join(pp.workspace, 'skills'))) skillCount = fs.readdirSync(path.join(pp.workspace, 'skills')).filter(f => { try { return fs.statSync(path.join(pp.workspace, 'skills', f)).isDirectory(); } catch { return false; } }).length; } catch {}
    const usage = aggregateUsage(pp);
    return {
      ...p, status: p.status || (p.active ? 'running' : 'stopped'), port: p.port || 3000,
      skillCount, hasSoul: !!findSoul(pp), hasMemory: fs.existsSync(path.join(pp.workspace, 'MEMORY.md')),
      totalCost: Math.round(usage.totals.estimatedCostUsd * 10000) / 10000,
      totalInput: usage.totals.inputTokens, totalOutput: usage.totals.outputTokens,
      telegramEnabled: !!getSettings().telegramBotToken
    };
  });
  res.json({ profiles });
});

app.post('/api/profiles', (req, res) => {
  const list = getProfiles();
  const id = `p-${Date.now()}`;
  list.push({ id, name: req.body?.name || `Profile ${list.length + 1}`, active: false, status: 'stopped', port: 3000, notes: req.body?.notes || '', soul: req.body?.soul || '', memoryPath: req.body?.memoryPath || '', createdAt: new Date().toISOString(), lastUsedAt: null });
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/activate', (req, res) => {
  const id = req.body?.id; const now = new Date().toISOString();
  const list = getProfiles().map(p => ({ ...p, active: p.id === id, status: p.id === id ? 'running' : (p.status || 'stopped'), port: p.port || 3000, lastUsedAt: p.id === id ? now : p.lastUsedAt }));
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/rename', (req, res) => {
  const { id, name } = req.body || {};
  const list = getProfiles().map(p => p.id === id ? { ...p, name: name || p.name } : p);
  saveProfiles(list); res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/update', (req, res) => {
  const { id, name, notes, soul, memoryPath } = req.body || {};
  const list = getProfiles().map(p => p.id === id ? { ...p, name: name ?? p.name, notes: notes ?? p.notes, soul: soul ?? p.soul, memoryPath: memoryPath ?? p.memoryPath } : p);
  saveProfiles(list); res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/delete', (req, res) => {
  const { id } = req.body || {};
  let list = getProfiles().filter(p => p.id !== id);
  if (!list.length) list = [{ id: 'default', name: 'Default', active: true, status: 'running', port: 3000, notes: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
  if (!list.some(p => p.active)) list[0].active = true;
  saveProfiles(list); res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/wizard', (req, res) => {
  const name = String(req.body?.name || 'Wizard Profile');
  const list = getProfiles().map(p => ({ ...p, active: false }));
  const id = `p-${Date.now()}`;
  list.push({ id, name, active: true, notes: '', soul: '', memoryPath: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() });
  saveProfiles(list);
  res.json({ ok: true, profile: list.find(p => p.id === id), profiles: list });
});

// ═══ PROFILE-LEVEL ENDPOINTS ═══
// Config
app.get('/api/profiles/:id/config', (req, res) => {
  const pp = profilePaths(req.params.id);
  const cfg = readJson(pp.configJson, null);
  if (cfg) return res.json({ config: cfg });
  // Fall back to QuickClaw yaml config
  const raw = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  res.json({ config: { path: CONFIG_PATH, raw } });
});
app.put('/api/profiles/:id/config', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.configJson)) {
    try { fs.writeFileSync(pp.configJson + '.bak', fs.readFileSync(pp.configJson, 'utf-8')); } catch {}
    fs.writeFileSync(pp.configJson, JSON.stringify(req.body.config, null, 2));
    return res.json({ ok: true });
  }
  res.json({ ok: false, error: 'Config file not found' });
});

// Env (API keys)
app.get('/api/profiles/:id/env', (req, res) => {
  const pp = profilePaths(req.params.id);
  const reveal = String(req.query.reveal || '').toLowerCase() === 'true';
  // Try real .env first, fall back to dashboard store
  let vars = {};
  if (fs.existsSync(pp.envPath)) {
    vars = readEnv(pp.envPath);
  } else {
    vars = getProfileEnv(req.params.id);
  }
  if (!reveal) {
    const masked = {};
    Object.entries(vars).forEach(([k, v]) => { masked[k] = /key|secret|token|password|api/i.test(k) ? maskKey(v) : v; });
    return res.json({ vars: masked });
  }
  res.json({ vars });
});

app.post('/api/profiles/:id/env/set', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { key, value } = req.body;
  if (fs.existsSync(pp.envPath)) {
    const v = readEnv(pp.envPath); v[key] = value; writeEnv(pp.envPath, v);
  } else {
    const st = getProfileEnvStore(); st[req.params.id] = st[req.params.id] || {}; st[req.params.id][key] = value; saveProfileEnvStore(st);
  }
  res.json({ ok: true });
});

app.delete('/api/profiles/:id/env/:key', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) {
    const v = readEnv(pp.envPath); delete v[req.params.key]; writeEnv(pp.envPath, v);
  } else {
    const st = getProfileEnvStore(); if (st[req.params.id]) delete st[req.params.id][req.params.key]; saveProfileEnvStore(st);
  }
  res.json({ ok: true });
});

app.post('/api/profiles/:id/env/:key/toggle', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { enabled } = req.body;
  if (fs.existsSync(pp.envPath)) {
    const v = readEnv(pp.envPath);
    const disabledKey = req.params.key + '_DISABLED';
    if (enabled) delete v[disabledKey]; else v[disabledKey] = 'true';
    writeEnv(pp.envPath, v);
  }
  res.json({ ok: true, enabled });
});

app.post('/api/profiles/:id/env/upload', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { content, merge } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  if (fs.existsSync(pp.envPath)) {
    try { fs.writeFileSync(pp.envPath + '.bak.' + Date.now(), fs.readFileSync(pp.envPath, 'utf-8')); } catch {}
    if (merge) {
      const existing = readEnv(pp.envPath); const incoming = {};
      content.split('\n').forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const eq = l.indexOf('='); if (eq < 1) return; incoming[l.slice(0, eq).trim()] = l.slice(eq + 1).trim(); });
      Object.assign(existing, incoming); writeEnv(pp.envPath, existing);
      return res.json({ ok: true, mode: 'merge', keysAdded: Object.keys(incoming).length });
    } else {
      fs.writeFileSync(pp.envPath, content);
      return res.json({ ok: true, mode: 'replace' });
    }
  }
  // Fall back to dashboard store
  const st = getProfileEnvStore(); st[req.params.id] = st[req.params.id] || {};
  let keysAdded = 0;
  content.split('\n').forEach(l => { const t = l.trim(); if (!t || t.startsWith('#') || !t.includes('=')) return; const idx = t.indexOf('='); const k = t.slice(0, idx).trim(); if (!k) return; st[req.params.id][k] = t.slice(idx + 1); keysAdded++; });
  saveProfileEnvStore(st);
  res.json({ ok: true, keysAdded });
});

app.post('/api/profiles/:id/env/purge', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) {
    const bak = pp.envPath + '.emergency-backup.' + Date.now();
    fs.copyFileSync(pp.envPath, bak);
    const v = readEnv(pp.envPath); const purged = [];
    Object.keys(v).forEach(k => { if (/key|secret|token|password|api/i.test(k) && !/DISABLED$/i.test(k)) { purged.push(k); delete v[k]; } });
    writeEnv(pp.envPath, v);
    return res.json({ ok: true, purged, backupFile: bak });
  }
  res.json({ ok: true, purged: [] });
});

app.get('/api/profiles/:id/env/download', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) return res.download(pp.envPath, `${req.params.id}-keys.env`);
  const varsObj = getProfileEnv(req.params.id);
  const lines = Object.entries(varsObj).map(([k, v]) => `${k}=${v}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.env"`);
  res.send(lines.join('\n'));
});

app.get('/api/env/download-all', (req, res) => {
  const st = getProfileEnvStore();
  const payload = { exportedAt: new Date().toISOString(), profiles: st };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="all-profile-env.json"');
  res.send(JSON.stringify(payload, null, 2));
});

// Profile start/stop/restart (gateway commands)
['restart', 'stop', 'start'].forEach(action => {
  app.post(`/api/profiles/:id/${action}`, async (req, res) => {
    const cmd = action === 'start' ? gatewayStartCommand() : (action === 'stop' ? gatewayStopCommand() : `${gatewayStopCommand()} && ${gatewayStartCommand()}`);
    const result = await run(`${cmd} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
    const gw = await gatewayState();
    res.json({ ok: true, status: gw.running ? 'running' : 'stopped' });
  });
});

// ═══ SKILLS ═══
app.get('/api/profiles/:id/skills', (req, res) => {
  const pp = profilePaths(req.params.id);
  const sd = path.join(pp.workspace, 'skills');
  const st = getSkillStates(pp);
  try {
    const sk = fs.readdirSync(sd).filter(f => { try { return fs.statSync(path.join(sd, f)).isDirectory(); } catch { return false; } }).map(n => {
      let m = {}; const mf = path.join(sd, n, 'skill.json'); if (fs.existsSync(mf)) m = readJson(mf, {});
      return { name: n, description: m.description || '', enabled: st[n] !== false };
    });
    res.json({ skills: sk });
  } catch { res.json({ skills: getSkills() }); }
});
app.post('/api/profiles/:id/skills/:skill/toggle', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { enabled } = req.body; const st = getSkillStates(pp); st[req.params.skill] = enabled; saveSkillStates(pp, st);
  const ap = path.join(pp.workspace, 'skills', req.params.skill), dp = ap + '.disabled';
  if (enabled && fs.existsSync(dp) && !fs.existsSync(ap)) fs.renameSync(dp, ap);
  else if (!enabled && fs.existsSync(ap)) fs.renameSync(ap, dp);
  res.json({ ok: true });
});
app.delete('/api/profiles/:id/skills/:skill', async (req, res) => {
  const pp = profilePaths(req.params.id);
  const sp = path.join(pp.workspace, 'skills', req.params.skill);
  await run(`rm -rf "${sp}" "${sp}.disabled"`);
  res.json({ ok: true });
});

// ═══ SOUL ═══
app.get('/api/profiles/:id/soul', (req, res) => {
  const pp = profilePaths(req.params.id);
  const sp = findSoul(pp);
  if (!sp) { const p = getProfiles().find(x => x.id === req.params.id); return res.json({ content: p?.soul || '', exists: false }); }
  res.json({ content: fs.readFileSync(sp, 'utf-8'), exists: true });
});
app.put('/api/profiles/:id/soul', (req, res) => {
  const pp = profilePaths(req.params.id);
  let sp = findSoul(pp) || path.join(pp.workspace, 'soul.md');
  if (fs.existsSync(sp)) try { fs.writeFileSync(sp + '.bak', fs.readFileSync(sp, 'utf-8')); } catch {}
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, req.body.content);
  res.json({ ok: true });
});

// ═══ MODELS ═══
app.get('/api/profiles/:id/models', (req, res) => {
  const pp = profilePaths(req.params.id);
  const cfg = readJson(pp.configJson, {});
  const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : getProfileEnv(req.params.id);
  let agentModel = null, agentModelPath = null;
  if (cfg.agents?.defaults?.model?.primary) { agentModel = cfg.agents.defaults.model.primary; agentModelPath = 'agents.defaults.model.primary'; }
  else if (typeof cfg.agents?.defaults?.model === 'string') { agentModel = cfg.agents.defaults.model; agentModelPath = 'agents.defaults.model (STRING)'; }
  else if (env.DEFAULT_MODEL) { agentModel = env.DEFAULT_MODEL; agentModelPath = 'env:DEFAULT_MODEL'; }
  const availableModels = cfg.agents?.defaults?.models ? Object.keys(cfg.agents.defaults.models) : [];
  const rawConfig = {};
  function scan(o, pfx) { if (!o || typeof o !== 'object') return; Object.entries(o).forEach(([k, v]) => { const fk = pfx ? pfx + '.' + k : k; if (/model|provider/i.test(k) && !/plugin|embedding|lancedb|memory/i.test(fk)) rawConfig[fk] = v; if (typeof v === 'object' && !Array.isArray(v) && !/plugin|entries/i.test(k)) scan(v, fk); }); }
  scan(cfg, '');
  Object.entries(env).forEach(([k, v]) => { if (/model|provider/i.test(k)) rawConfig['env:' + k] = v; });
  res.json({ models: { agentModel, agentModelPath, availableModels, rawConfig } });
});

app.put('/api/profiles/:id/models', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { model, key, value, target } = req.body;
  const cfg = readJson(pp.configJson, {});
  if (fs.existsSync(pp.configJson)) try { fs.writeFileSync(pp.configJson + '.bak', fs.readFileSync(pp.configJson, 'utf-8')); } catch {}
  if (model) {
    if (!cfg.agents) cfg.agents = {}; if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (!cfg.agents.defaults.model || typeof cfg.agents.defaults.model !== 'object') cfg.agents.defaults.model = {};
    cfg.agents.defaults.model.primary = model;
    if (!cfg.agents.defaults.models) cfg.agents.defaults.models = {};
    if (!cfg.agents.defaults.models[model]) cfg.agents.defaults.models[model] = {};
    writeJson(pp.configJson, cfg);
    return res.json({ ok: true, agentModel: model });
  }
  if (target === 'env' && fs.existsSync(pp.envPath)) { const v = readEnv(pp.envPath); if (value === null || value === '') delete v[key]; else v[key] = value; writeEnv(pp.envPath, v); }
  else if (key) { const ks = key.split('.'); let o = cfg; for (let i = 0; i < ks.length - 1; i++) { if (!o[ks[i]]) o[ks[i]] = {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = value; writeJson(pp.configJson, cfg); }
  res.json({ ok: true });
});

// ═══ LOGS ═══
app.get('/api/profiles/:id/logs', (req, res) => {
  const lines = parseInt(req.query.lines || '150', 10);
  const logs = tailFile('gateway.log', lines);
  res.json({ ok: true, logs });
});

// ═══ USAGE ═══
app.get('/api/profiles/:id/usage', (req, res) => {
  const pp = profilePaths(req.params.id);
  const usage = aggregateUsage(pp);
  if (usage.noData) usage.hint = 'No usage-log.json found. Token tracking requires OpenClaw to write usage data during sessions.';
  res.json(usage);
});

app.get('/api/usage/all', (req, res) => {
  const all = {}; let gIn = 0, gOut = 0, gCost = 0;
  for (const p of getProfiles()) {
    const pp = profilePaths(p.id);
    const u = aggregateUsage(pp);
    all[p.id] = { inputTokens: u.totals.inputTokens, outputTokens: u.totals.outputTokens, cost: u.totals.estimatedCostUsd, lastModified: u.lastModified, daysTracked: u.daysTracked, sources: u.sources };
    gIn += u.totals.inputTokens; gOut += u.totals.outputTokens; gCost += u.totals.estimatedCostUsd;
  }
  res.json({ profiles: all, totals: { inputTokens: gIn, outputTokens: gOut, cost: Math.round(gCost * 10000) / 10000 } });
});

// ═══ SESSIONS / MEMORY BROWSER ═══
app.get('/api/profiles/:id/sessions', (req, res) => {
  const pp = profilePaths(req.params.id);
  const locs = [path.join(pp.configDir, 'agents', 'main', 'sessions', 'sessions.json'), path.join(pp.configDir, 'sessions', 'sessions.json')];
  let sessions = null; for (const l of locs) if (fs.existsSync(l)) { sessions = readJson(l, null); break; }
  const memDir = path.join(pp.workspace, 'memory'); let memFiles = [];
  if (fs.existsSync(memDir)) try {
    memFiles = fs.readdirSync(memDir).filter(f => (f.endsWith('.md') || f.endsWith('.json')) && !f.startsWith('.')).sort().reverse().map(f => {
      const fp = path.join(memDir, f); const st = fs.statSync(fp); const c = fs.readFileSync(fp, 'utf-8');
      return { name: f, size: c.length, modified: st.mtime.toISOString(), preview: c.slice(0, 500), type: f.endsWith('.json') ? 'json' : 'markdown' };
    });
  } catch {}
  const special = [];
  ['MEMORY.md', 'HEARTBEAT.md', 'TODO.md', 'STATUS.md'].forEach(f => {
    const fp = path.join(pp.workspace, f);
    if (fs.existsSync(fp)) { const c = fs.readFileSync(fp, 'utf-8'); special.push({ name: f, size: c.length, preview: c.slice(0, 500), type: 'markdown', location: 'workspace' }); }
  });
  res.json({ sessions: sessions || {}, memoryFiles: memFiles, specialFiles: special });
});

app.get('/api/profiles/:id/memory/:file', (req, res) => {
  const pp = profilePaths(req.params.id);
  let fp = path.join(pp.workspace, 'memory', req.params.file);
  if (!fs.existsSync(fp)) fp = path.join(pp.workspace, req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: fs.readFileSync(fp, 'utf-8') });
});
app.put('/api/profiles/:id/memory/:file', (req, res) => {
  const pp = profilePaths(req.params.id);
  let fp = path.join(pp.workspace, 'memory', req.params.file);
  if (!fs.existsSync(fp)) fp = path.join(pp.workspace, req.params.file);
  if (fs.existsSync(fp)) try { fs.writeFileSync(fp + '.bak', fs.readFileSync(fp, 'utf-8')); } catch {}
  fs.writeFileSync(fp, req.body.content); res.json({ ok: true });
});
app.delete('/api/profiles/:id/memory/:file', (req, res) => {
  const pp = profilePaths(req.params.id);
  const fp = path.join(pp.workspace, 'memory', req.params.file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const archDir = path.join(pp.workspace, 'memory-archive'); fs.mkdirSync(archDir, { recursive: true });
  fs.renameSync(fp, path.join(archDir, req.params.file));
  res.json({ ok: true, message: 'Archived' });
});

// ═══ CHANNELS / TELEGRAM ═══
app.get('/api/profiles/:id/channels', (req, res) => {
  const pp = profilePaths(req.params.id);
  const cfg = readJson(pp.configJson, {});
  res.json({ channels: cfg.channels || { telegram: { enabled: !!getSettings().telegramBotToken } } });
});
app.get('/api/profiles/:id/channels/status', async (req, res) => {
  const pp = profilePaths(req.params.id);
  const r = await run(`${cliBin()} channels status 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 10000 });
  res.json({ ok: r.ok, output: cleanCli(r.output) });
});
app.get('/api/profiles/:id/pairing', async (req, res) => {
  const r = await run(`${cliBin()} pairing list telegram 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 10000 });
  res.json({ ok: r.ok, output: cleanCli(r.output) });
});
app.post('/api/profiles/:id/pairing/approve', async (req, res) => {
  const { code } = req.body;
  const r = await run(`${cliBin()} pairing approve telegram ${code} 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 10000 });
  res.json({ ok: r.ok, output: cleanCli(r.output) });
});
app.get('/api/profiles/:id/telegram/users', (req, res) => {
  const pp = profilePaths(req.params.id);
  const cfg = readJson(pp.configJson, {}); const tg = cfg.channels?.telegram || {};
  const allowFile = path.join(pp.configDir, 'credentials', 'telegram-allowFrom.json');
  const allow = readJson(allowFile, null);
  const users = allow?.allowFrom || cfg.pairing?.telegram?.approved || tg.allowedUsers || [];
  res.json({ users, botToken: tg.botToken ? maskKey(tg.botToken) : (getSettings().telegramBotToken ? maskKey(getSettings().telegramBotToken) : null), enabled: tg.enabled || !!getSettings().telegramBotToken });
});
app.get('/api/profiles/:id/telegram/info', (req, res) => {
  const pp = profilePaths(req.params.id);
  const cfg = readJson(pp.configJson, {}); const tg = cfg.channels?.telegram || {};
  const plugin = cfg.plugins?.entries?.telegram || {};
  const allowFile = path.join(pp.configDir, 'credentials', 'telegram-allowFrom.json');
  const allow = readJson(allowFile, null);
  const token = tg.botToken || getSettings().telegramBotToken || '';
  res.json({ enabled: !!(tg.enabled || token), botToken: token ? maskKey(token) : null, hasToken: !!token, users: allow?.allowFrom || [], pluginEnabled: !!plugin.enabled, channelEnabled: !!tg.enabled });
});
app.post('/api/profiles/:id/telegram/users/add', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { userId } = req.body; if (!userId) return res.status(400).json({ error: 'userId required' });
  const credDir = path.join(pp.configDir, 'credentials'); fs.mkdirSync(credDir, { recursive: true });
  const allowFile = path.join(credDir, 'telegram-allowFrom.json');
  const allow = readJson(allowFile, null) || { version: 1, allowFrom: [] };
  if (!Array.isArray(allow.allowFrom)) allow.allowFrom = [];
  const uid = String(userId).trim();
  if (!allow.allowFrom.some(u => String(u) === uid)) { allow.allowFrom.push(uid); writeJson(allowFile, allow); }
  res.json({ ok: true, users: allow.allowFrom });
});
app.delete('/api/profiles/:id/telegram/users/:index', (req, res) => {
  const pp = profilePaths(req.params.id);
  const idx = parseInt(req.params.index);
  const allowFile = path.join(pp.configDir, 'credentials', 'telegram-allowFrom.json');
  const allow = readJson(allowFile, null);
  if (!allow || !Array.isArray(allow.allowFrom)) return res.status(404).json({ error: 'No allowFrom file' });
  if (idx < 0 || idx >= allow.allowFrom.length) return res.status(400).json({ error: 'Invalid index' });
  const removed = allow.allowFrom.splice(idx, 1);
  writeJson(allowFile, allow);
  res.json({ ok: true, removed: removed[0], users: allow.allowFrom });
});
app.put('/api/profiles/:id/telegram/setup', (req, res) => {
  const botToken = String(req.body?.botToken || '').trim();
  if (!botToken || !botToken.includes(':')) return res.status(400).json({ ok: false, error: 'Invalid bot token format' });
  saveSettings({ telegramBotToken: botToken });
  const sync = writeOpenclawTelegramToken(botToken);
  res.json({ ok: true, message: 'Telegram bot token saved.', sync, instructions: 'Restart gateway, then message your bot with /start.' });
});

// ═══ GENERIC CHANNEL SETUP (Discord, WhatsApp, iMessage) ═══
app.get('/api/profiles/:id/channel/:channel', (req, res) => {
  const pp = profilePaths(req.params.id); const ch = req.params.channel;
  const cfg = readJson(pp.configJson, {}); const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : {};
  const plugin = cfg.plugins?.entries?.[ch] || {}; const chanCfg = cfg.channels?.[ch] || {};
  const reveal = req.query.reveal === 'true';
  const info = { enabled: !!plugin.enabled && !!chanCfg.enabled, pluginEnabled: !!plugin.enabled, channelEnabled: !!chanCfg.enabled, config: chanCfg };
  if (ch === 'discord') { info.botToken = env.DISCORD_BOT_TOKEN ? (reveal ? env.DISCORD_BOT_TOKEN : maskKey(env.DISCORD_BOT_TOKEN)) : null; info.hasToken = !!env.DISCORD_BOT_TOKEN; info.applicationId = env.DISCORD_APPLICATION_ID || chanCfg.applicationId || ''; info.guildId = env.DISCORD_GUILD_ID || chanCfg.guildId || ''; }
  else if (ch === 'whatsapp') { info.sessionExists = false; info.phoneNumber = env.WHATSAPP_PHONE || chanCfg.phoneNumber || ''; info.apiKey = env.WHATSAPP_API_KEY ? (reveal ? env.WHATSAPP_API_KEY : maskKey(env.WHATSAPP_API_KEY)) : null; info.hasApiKey = !!env.WHATSAPP_API_KEY; info.bridgeType = chanCfg.bridge || env.WHATSAPP_BRIDGE || 'baileys'; }
  else if (ch === 'imessage' || ch === 'bluebubbles') { info.serverUrl = env.BLUEBUBBLES_URL || chanCfg.serverUrl || ''; info.password = env.BLUEBUBBLES_PASSWORD ? (reveal ? env.BLUEBUBBLES_PASSWORD : maskKey(env.BLUEBUBBLES_PASSWORD)) : null; info.hasPassword = !!env.BLUEBUBBLES_PASSWORD; }
  res.json(info);
});
app.put('/api/profiles/:id/channel/:channel/setup', (req, res) => {
  const pp = profilePaths(req.params.id); const ch = req.params.channel;
  const cfg = readJson(pp.configJson, {});
  if (fs.existsSync(pp.configJson)) try { fs.writeFileSync(pp.configJson + '.bak', fs.readFileSync(pp.configJson, 'utf-8')); } catch {}
  if (!cfg.plugins) cfg.plugins = {}; if (!cfg.plugins.entries) cfg.plugins.entries = {}; if (!cfg.channels) cfg.channels = {};
  const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : {};
  const { enabled } = req.body;
  cfg.plugins.entries[ch] = { enabled: enabled !== false };
  if (ch === 'discord') { const { botToken, applicationId, guildId } = req.body; if (botToken) env.DISCORD_BOT_TOKEN = botToken; if (applicationId !== undefined) env.DISCORD_APPLICATION_ID = applicationId; if (guildId !== undefined) env.DISCORD_GUILD_ID = guildId; cfg.channels.discord = { enabled: enabled !== false }; }
  else if (ch === 'whatsapp') { const { phoneNumber, apiKey, bridgeType } = req.body; if (apiKey) env.WHATSAPP_API_KEY = apiKey; if (phoneNumber !== undefined) env.WHATSAPP_PHONE = phoneNumber; cfg.channels.whatsapp = { enabled: enabled !== false, bridge: bridgeType || 'baileys' }; }
  else if (ch === 'imessage' || ch === 'bluebubbles') { const { serverUrl, password } = req.body; if (serverUrl !== undefined) env.BLUEBUBBLES_URL = serverUrl; if (password) env.BLUEBUBBLES_PASSWORD = password; cfg.channels.bluebubbles = { enabled: enabled !== false }; cfg.plugins.entries.bluebubbles = { enabled: enabled !== false }; }
  if (fs.existsSync(pp.envPath)) writeEnv(pp.envPath, env);
  if (fs.existsSync(pp.configJson)) writeJson(pp.configJson, cfg);
  res.json({ ok: true, message: ch + ' configured. Restart gateway to apply.' });
});

// ═══ CRON JOB MANAGER ═══
app.get('/api/profiles/:id/cron', async (req, res) => {
  const pp = profilePaths(req.params.id);
  const r = await run(`${cliBin()} cron list 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 10000 });
  let files = [];
  const cronDirs = [path.join(HOME, '.openclaw', 'cron'), path.join(pp.configDir.replace('.clawdbot', '.openclaw'), 'cron'), path.join(pp.configDir, 'cron')];
  cronDirs.forEach(cronDir => { try { if (fs.existsSync(cronDir)) fs.readdirSync(cronDir).filter(f => f.endsWith('.json') && f !== 'runs').forEach(f => { const j = readJson(path.join(cronDir, f), null); if (j && !files.some(x => x.id === j.id)) files.push(j); }); } catch {} });
  const cfg = readJson(pp.configJson, {}); const hb = cfg.agents?.defaults?.heartbeat;
  let heartbeat = null;
  if (hb && hb.every) heartbeat = { id: 'heartbeat', name: 'Heartbeat', schedule: hb.every, type: 'heartbeat', enabled: true, config: hb };
  // Parse launchd/crontab on macOS
  const crontab = runSync('crontab -l 2>/dev/null');
  if (crontab.ok && crontab.output) {
    crontab.output.split('\n').filter(l => l.trim() && !l.startsWith('#')).forEach((line, i) => {
      const m = line.match(/^([*\/0-9,\-\s]{9,})\s+(.+)$/);
      if (m && !files.some(x => x.id === 'sys-cron-' + i)) {
        const schedule = m[1].trim(), cmd = m[2].trim();
        files.push({ id: 'sys-cron-' + i, name: cmd.match(/([^\s\/]+)$/)?.[1] || 'cron-' + i, schedule, type: 'system', enabled: true, isSystem: true });
      }
    });
  }
  res.json({ ok: r.ok, output: cleanCli(r.output), jobs: files, heartbeat });
});
app.post('/api/profiles/:id/cron/add', async (req, res) => {
  const { name, schedule, scheduleType, message } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  let cmd = `${cliBin()} cron add --name "${name.replace(/"/g, '\\"')}"`;
  if (scheduleType === 'cron' && schedule) cmd += ` --cron "${schedule}"`;
  else if (scheduleType === 'at' && schedule) cmd += ` --at "${schedule}"`;
  else if (scheduleType === 'every' && schedule) cmd += ` --every "${schedule}"`;
  cmd += ` --message "${message.replace(/"/g, '\\"')}"`;
  const r = await run(`${cmd} 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 15000 });
  res.json({ ok: r.ok, output: cleanCli(r.output) });
});
app.post('/api/profiles/:id/cron/:jobId/pause', async (req, res) => { const r = await run(`${cliBin()} cron pause ${req.params.jobId} 2>/dev/null`, { env: profileEnvVars(req.params.id) }); res.json({ ok: r.ok, output: cleanCli(r.output) }); });
app.post('/api/profiles/:id/cron/:jobId/resume', async (req, res) => { const r = await run(`${cliBin()} cron resume ${req.params.jobId} 2>/dev/null`, { env: profileEnvVars(req.params.id) }); res.json({ ok: r.ok, output: cleanCli(r.output) }); });
app.delete('/api/profiles/:id/cron/:jobId', async (req, res) => { const r = await run(`${cliBin()} cron remove ${req.params.jobId} 2>/dev/null`, { env: profileEnvVars(req.params.id) }); res.json({ ok: r.ok, output: cleanCli(r.output) }); });
app.post('/api/profiles/:id/cron/:jobId/run', async (req, res) => { const r = await run(`${cliBin()} cron run ${req.params.jobId} 2>/dev/null`, { env: profileEnvVars(req.params.id), timeout: 30000 }); res.json({ ok: r.ok, output: cleanCli(r.output) }); });
app.get('/api/profiles/:id/cron/runs', async (req, res) => { const r = await run(`${cliBin()} cron runs 2>/dev/null`, { env: profileEnvVars(req.params.id) }); res.json({ ok: r.ok, output: cleanCli(r.output) }); });

// ═══ ACTIVITY FEED (per-profile) ═══
app.get('/api/profiles/:id/activity', (req, res) => {
  const events = [];
  const gwLog = tailFile('gateway.log', 50);
  if (gwLog) {
    gwLog.split('\n').forEach(line => {
      if (!line.trim()) return;
      let type = 'system', icon = '⚙️', msg = line.trim();
      if (/tool|skill/i.test(msg)) { type = 'tool'; icon = '🔧'; }
      else if (/telegram|channel|message.*received/i.test(msg)) { type = 'message'; icon = '💬'; }
      else if (/cron|heartbeat/i.test(msg)) { type = 'cron'; icon = '⏰'; }
      else if (/error|fail/i.test(msg)) { type = 'error'; icon = '❌'; }
      else if (/start|running|active/i.test(msg)) { type = 'status'; icon = '🟢'; }
      events.push({ time: new Date().toISOString(), type, icon, message: msg.slice(0, 200) });
    });
  }
  res.json({ events: events.reverse().slice(0, 50) });
});

// ═══ FTP ═══
app.get('/api/profiles/:id/ftp', (req, res) => {
  const pp = profilePaths(req.params.id);
  const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : {};
  const hasFtpSkill = fs.existsSync(path.join(pp.workspace, 'skills', 'ftp-deploy'));
  res.json({ host: env.FTP_HOST || getSettings().ftpHost || '', user: env.FTP_USER || getSettings().ftpUser || '', pass: env.FTP_PASS ? maskKey(env.FTP_PASS) : '', port: env.FTP_PORT || '21', hasCredentials: !!(env.FTP_HOST && env.FTP_USER) || !!getSettings().ftpHost, ftpEnabled: env.FTP_ENABLED !== 'false', hasFtpSkill, revealPass: req.query.reveal === 'true' ? (env.FTP_PASS || '') : undefined });
});
app.put('/api/profiles/:id/ftp', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { host, user, pass, port } = req.body;
  if (fs.existsSync(pp.envPath)) {
    const env = readEnv(pp.envPath);
    if (host !== undefined) env.FTP_HOST = host; if (user !== undefined) env.FTP_USER = user; if (pass !== undefined) env.FTP_PASS = pass; if (port !== undefined) env.FTP_PORT = port || '21';
    writeEnv(pp.envPath, env);
  } else { saveSettings({ ftpHost: host || '', ftpUser: user || '' }); }
  res.json({ ok: true });
});
app.post('/api/profiles/:id/ftp/toggle', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) { const env = readEnv(pp.envPath); env.FTP_ENABLED = req.body.enabled ? 'true' : 'false'; writeEnv(pp.envPath, env); }
  res.json({ ok: true, ftpEnabled: req.body.enabled });
});

// ═══ SMTP ═══
app.get('/api/profiles/:id/smtp', (req, res) => {
  const pp = profilePaths(req.params.id);
  const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : {};
  res.json({ host: env.SMTP_HOST || '', port: env.SMTP_PORT || '587', user: env.SMTP_USER || getSettings().emailUser || '', pass: env.SMTP_PASS ? maskKey(env.SMTP_PASS) : '', from: env.SMTP_FROM || '', secure: env.SMTP_SECURE === 'true', hasCredentials: !!(env.SMTP_HOST && env.SMTP_USER), smtpEnabled: env.SMTP_ENABLED !== 'false', revealPass: req.query.reveal === 'true' ? (env.SMTP_PASS || '') : undefined });
});
app.put('/api/profiles/:id/smtp', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { host, port, user, pass, from, secure } = req.body;
  if (fs.existsSync(pp.envPath)) {
    const env = readEnv(pp.envPath);
    if (host !== undefined) env.SMTP_HOST = host; if (port !== undefined) env.SMTP_PORT = port; if (user !== undefined) env.SMTP_USER = user; if (pass !== undefined) env.SMTP_PASS = pass; if (from !== undefined) env.SMTP_FROM = from; if (secure !== undefined) env.SMTP_SECURE = secure ? 'true' : 'false';
    writeEnv(pp.envPath, env);
  }
  res.json({ ok: true });
});
app.post('/api/profiles/:id/smtp/toggle', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) { const env = readEnv(pp.envPath); env.SMTP_ENABLED = req.body.enabled ? 'true' : 'false'; writeEnv(pp.envPath, env); }
  res.json({ ok: true, smtpEnabled: req.body.enabled });
});

// ═══ SECURITY AUDIT — Mac-adapted ═══
app.get('/api/security/audit', async (req, res) => {
  const gw = await gatewayState();
  const a = { checks: [], summary: {} };
  function add(cat, name, status, detail, severity, extra = {}) { a.checks.push({ category: cat, name, status, detail, severity, ...extra }); }

  add('Gateway', 'Gateway running', gw.running ? 'pass' : 'warn', gw.running ? 'Active' : 'Not running', 'high');
  add('Config', 'Config file exists', fs.existsSync(CONFIG_PATH) ? 'pass' : 'warn', fs.existsSync(CONFIG_PATH) ? 'Present' : 'Missing', 'medium');

  // macOS firewall check
  const fw = runSync('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null');
  add('Firewall', 'macOS Firewall', fw.output?.includes('enabled') ? 'pass' : 'warn', fw.output?.includes('enabled') ? 'Enabled' : 'Not enabled', 'medium', {
    explanation: 'The macOS application firewall helps protect against unwanted incoming connections.',
    manualFix: 'System Settings → Network → Firewall → Turn On'
  });

  // Check .env file permissions
  let envSecure = true;
  for (const p of getProfiles()) {
    const pp = profilePaths(p.id);
    if (fs.existsSync(pp.envPath)) { const mode = fs.statSync(pp.envPath).mode; if (mode & 0o077) envSecure = false; }
  }
  add('Files', 'Env permissions', envSecure ? 'pass' : 'warn', envSecure ? 'Restricted' : 'Loose — some .env files are world-readable', 'high', {
    explanation: 'Your .env files contain API keys. File permissions should be restricted (chmod 600).',
    fixId: 'env-perms', fixDesc: 'Set all .env files to chmod 600'
  });

  // SIP check
  const sip = runSync('csrutil status 2>/dev/null');
  add('System', 'SIP (System Integrity Protection)', sip.output?.includes('enabled') ? 'pass' : 'warn', sip.output?.includes('enabled') ? 'Enabled' : 'Disabled or unknown', 'medium', {
    explanation: 'SIP protects critical system files from modification. Keep it enabled unless you have a specific reason to disable it.'
  });

  // Disk encryption
  const fv = runSync('fdesetup status 2>/dev/null');
  add('Encryption', 'FileVault', fv.output?.includes('On') ? 'pass' : 'info', fv.output?.includes('On') ? 'Enabled' : 'Not detected (check System Settings)', 'medium', {
    explanation: 'FileVault encrypts your entire disk, protecting your API keys and data if your Mac is stolen.'
  });

  // Node/npm versions
  const nodeV = runSync('node --version 2>/dev/null');
  add('System', 'Node.js', nodeV.ok ? 'pass' : 'fail', nodeV.output || 'Not found', 'high');

  const cn = { pass: 0, warn: 0, fail: 0, info: 0 }; a.checks.forEach(c => cn[c.status]++);
  a.summary = cn; a.score = Math.max(0, 100 - (cn.fail * 25) - (cn.warn * 10));
  res.json(a);
});

app.post('/api/security/fix', (req, res) => {
  const { fixId } = req.body;
  if (!fixId) return res.status(400).json({ error: 'fixId required' });
  if (fixId === 'env-perms') {
    for (const p of getProfiles()) { const pp = profilePaths(p.id); if (fs.existsSync(pp.envPath)) try { fs.chmodSync(pp.envPath, 0o600); } catch {} }
    return res.json({ ok: true, message: 'All .env files set to chmod 600' });
  }
  res.status(400).json({ error: 'Unknown fix: ' + fixId });
});

// ═══ FILE BROWSER ═══
app.get('/api/profiles/:id/browse', (req, res) => {
  const pp = profilePaths(req.params.id);
  const dir = req.query.dir;
  const roots = [
    { label: 'config', path: path.resolve(pp.configDir) },
    { label: 'workspace', path: path.resolve(pp.workspace) }
  ];
  if (!dir) return res.json({ roots: roots.map(r => ({ ...r, exists: fs.existsSync(r.path) })) });
  const resolved = path.resolve(dir);
  if (!roots.some(r => resolved === r.path || resolved.startsWith(r.path + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  try {
    const items = fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort().map(name => {
      const fp = path.join(dir, name);
      try { const s = fs.statSync(fp); return { name, path: fp, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString(), ext: path.extname(name).toLowerCase() }; }
      catch { return { name, path: fp, isDir: false, size: 0, error: true }; }
    });
    items.sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
    res.json({ dir, items, parent: path.dirname(dir) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/profiles/:id/readfile', (req, res) => {
  const pp = profilePaths(req.params.id);
  const fp = req.query.path;
  const roots = [path.resolve(pp.configDir), path.resolve(pp.workspace)];
  const resolved = path.resolve(fp || '');
  if (!fp || !roots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(fp);
  if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'File too large (>2MB)' });
  const ext = path.extname(fp).toLowerCase();
  const textExts = ['.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.env', '.js', '.ts', '.sh', '.py', '.html', '.css', '.xml', '.ini', '.cfg', '.conf', '.log', ''];
  if (!textExts.includes(ext)) return res.json({ content: null, binary: true, size: stat.size, ext });
  res.json({ content: fs.readFileSync(fp, 'utf-8'), size: stat.size, ext, modified: stat.mtime.toISOString(), sensitive: /\.env$|secret|token|password|key/i.test(fp) });
});
app.put('/api/profiles/:id/writefile', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { filePath, content } = req.body;
  const roots = [path.resolve(pp.configDir), path.resolve(pp.workspace)];
  const resolved = path.resolve(filePath || '');
  if (!filePath || !roots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  if (fs.existsSync(filePath)) try { fs.writeFileSync(filePath + '.bak', fs.readFileSync(filePath)); } catch {}
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content); res.json({ ok: true });
});
app.post('/api/profiles/:id/mkdir', (req, res) => {
  const pp = profilePaths(req.params.id);
  const { dirPath } = req.body;
  const roots = [path.resolve(pp.configDir), path.resolve(pp.workspace)];
  const resolved = path.resolve(dirPath || '');
  if (!dirPath || !roots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  fs.mkdirSync(dirPath, { recursive: true }); res.json({ ok: true });
});
app.delete('/api/profiles/:id/deletefile', (req, res) => {
  const pp = profilePaths(req.params.id);
  const fp = req.query.path;
  const roots = [path.resolve(pp.configDir), path.resolve(pp.workspace)];
  const resolved = path.resolve(fp || '');
  if (!fp || !roots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const trashDir = path.join(DATA_DIR, '.trash'); fs.mkdirSync(trashDir, { recursive: true });
  const stat = fs.statSync(fp);
  if (stat.isDirectory()) fs.renameSync(fp, path.join(trashDir, Date.now() + '-' + path.basename(fp)));
  else { fs.copyFileSync(fp, path.join(trashDir, Date.now() + '-' + path.basename(fp))); fs.unlinkSync(fp); }
  res.json({ ok: true });
});

// ═══ SYSTEM FILE BROWSER ═══
app.get('/api/system/browse', (req, res) => {
  const dir = req.query.dir;
  const allowedRoots = [ROOT, HOME, '/tmp'];
  if (!dir) return res.json({ roots: [{ label: 'QuickClaw Root', path: ROOT }, { label: 'Home (~)', path: HOME }, { label: 'Temp', path: '/tmp' }].filter(r => fs.existsSync(r.path)) });
  const resolved = path.resolve(dir);
  if (!allowedRoots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Path not allowed' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' });
  try {
    const items = fs.readdirSync(dir).filter(f => !f.startsWith('.')).sort().map(name => {
      const fp = path.join(dir, name);
      try { const s = fs.statSync(fp); return { name, path: fp, isDir: s.isDirectory(), size: s.size, modified: s.mtime.toISOString(), ext: path.extname(name).toLowerCase() }; }
      catch { return { name, path: fp, isDir: false, size: 0, error: true }; }
    });
    items.sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name));
    res.json({ dir, items, parent: path.dirname(dir) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/system/readfile', (req, res) => {
  try {
    const fp = req.query.path || '';
    const resolved = path.resolve(fp);
    const allowedRoots = [ROOT, HOME, '/tmp'];
    if (!allowedRoots.some(r => resolved === r || resolved.startsWith(r + '/'))) return res.status(403).json({ error: 'Not allowed' });
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const stat = fs.statSync(fp);
    if (stat.size > 2 * 1024 * 1024) return res.json({ content: null, binary: true, size: stat.size });
    const ext = path.extname(fp).toLowerCase();
    const textExts = ['.json', '.md', '.txt', '.yml', '.yaml', '.toml', '.env', '.js', '.ts', '.sh', '.py', '.html', '.css', '.xml', '.ini', '.cfg', '.conf', '.log', ''];
    if (!textExts.includes(ext)) return res.json({ content: null, binary: true, size: stat.size, ext });
    res.json({ content: fs.readFileSync(fp, 'utf-8'), size: stat.size, ext, modified: stat.mtime.toISOString() });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.put('/api/system/writefile', (req, res) => {
  try {
    const p = ensureWithinRoot(req.body?.path || '');
    fs.writeFileSync(p, req.body?.content || '', 'utf8');
    res.json({ ok: true, path: p });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ═══ DASHBOARD CODE EDITOR ═══
app.get('/api/dashboard/files', (req, res) => {
  const dashDir = path.resolve(__dirname); const files = [];
  function scanDir(dir, prefix) {
    try { fs.readdirSync(dir).forEach(name => { if (name.startsWith('.') || name === 'node_modules') return; const fp = path.join(dir, name); const rel = prefix ? prefix + '/' + name : name; try { const s = fs.statSync(fp); if (s.isDirectory()) scanDir(fp, rel); else files.push({ name: rel, path: fp, size: s.size, modified: s.mtime.toISOString(), ext: path.extname(name).toLowerCase() }); } catch {} }); } catch {}
  }
  scanDir(dashDir, '');
  res.json({ files, dir: dashDir });
});
app.get('/api/dashboard/file', (req, res) => {
  const fp = req.query.path; if (!fp) return res.status(400).json({ error: 'path required' });
  const dashDir = path.resolve(__dirname); const resolved = path.resolve(fp);
  if (!resolved.startsWith(dashDir)) return res.status(403).json({ error: 'Path not in dashboard directory' });
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(fp);
  if (stat.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'Too large' });
  res.json({ content: fs.readFileSync(fp, 'utf-8'), size: stat.size, modified: stat.mtime.toISOString() });
});
app.put('/api/dashboard/file', (req, res) => {
  const { filePath, content } = req.body; if (!filePath) return res.status(400).json({ error: 'filePath required' });
  const dashDir = path.resolve(__dirname); const resolved = path.resolve(filePath);
  if (!resolved.startsWith(dashDir)) return res.status(403).json({ error: 'Path not in dashboard directory' });
  if (fs.existsSync(filePath)) {
    const bakDir = path.join(dashDir, '.backups'); fs.mkdirSync(bakDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(bakDir, path.basename(filePath) + '.' + ts + '.bak'), fs.readFileSync(filePath));
  }
  fs.writeFileSync(filePath, content); res.json({ ok: true });
});
app.post('/api/dashboard/restart', (req, res) => {
  res.json({ ok: true, message: 'Restart via QuickClaw_Launch.command recommended.' });
});

// ═══ UPDATES ═══
app.get('/api/updates/cli', async (req, res) => {
  const c = await run(`${cliBin()} --version 2>/dev/null`);
  const l = await run('npm show openclaw version 2>/dev/null', { timeout: 20000 });
  res.json({ current: cleanCli(c.output), latest: l.output, updateAvailable: c.output !== l.output && l.ok });
});
app.post('/api/updates/cli/upgrade', async (req, res) => {
  const r = await run('npm install -g openclaw@latest 2>&1', { timeout: 180000 });
  const v = await run(`${cliBin()} --version 2>/dev/null`);
  res.json({ ok: r.ok, version: cleanCli(v.output) || 'unknown', output: cleanCli(r.output || ''), error: r.ok ? null : r.output });
});
app.get('/api/updates/workspace/:id', async (req, res) => {
  const pp = profilePaths(req.params.id);
  if (!fs.existsSync(path.join(pp.workspace, '.git'))) return res.json({ isGit: false });
  await run(`cd "${pp.workspace}" && git fetch origin 2>/dev/null`, { timeout: 20000 });
  const b = await run(`cd "${pp.workspace}" && git branch --show-current 2>/dev/null`);
  const bh = await run(`cd "${pp.workspace}" && git rev-list --count HEAD..origin/${b.output || 'main'} 2>/dev/null`);
  const lc = await run(`cd "${pp.workspace}" && git log -1 --format="%h %s" 2>/dev/null`);
  const d = await run(`cd "${pp.workspace}" && git status --porcelain 2>/dev/null`);
  res.json({ isGit: true, branch: b.output, behindBy: parseInt(bh.output) || 0, lastCommit: lc.output, dirty: !!d.output });
});
app.post('/api/updates/workspace/:id/pull', async (req, res) => {
  const pp = profilePaths(req.params.id);
  await run(`cd "${pp.workspace}" && git stash 2>/dev/null`);
  const r = await run(`cd "${pp.workspace}" && git pull 2>/dev/null`, { timeout: 60000 });
  await run(`cd "${pp.workspace}" && git stash pop 2>/dev/null`);
  res.json({ ok: r.ok, output: r.output });
});

// ═══ VERSION TIMELINE ═══
app.post('/api/versions/snapshot', (req, res) => {
  const { label, markAsBase } = req.body;
  const versionId = 'v-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const vDir = path.join(VERSIONS_DIR, versionId);
  fs.mkdirSync(vDir, { recursive: true });
  const dashDir = path.resolve(__dirname); const filesToSave = [];
  function collectFiles(dir, prefix) {
    try { fs.readdirSync(dir).forEach(name => { if (name.startsWith('.') || name === 'node_modules') return; const fp = path.join(dir, name); const rel = prefix ? prefix + '/' + name : name; try { const s = fs.statSync(fp); if (s.isDirectory()) collectFiles(fp, rel); else filesToSave.push({ rel, abs: fp }); } catch {} }); } catch {}
  }
  collectFiles(dashDir, '');
  filesToSave.forEach(f => { const dest = path.join(vDir, f.rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f.abs, dest); });
  const meta = getVersions();
  const versionInfo = { id: versionId, label: label || 'Snapshot', timestamp: new Date().toISOString(), fileCount: filesToSave.length, isBase: !!markAsBase };
  meta.versions.push(versionInfo);
  if (!meta.current) meta.current = versionId;
  if (markAsBase) meta.baseStable = versionId;
  saveVersionsMeta(meta);
  res.json({ ok: true, version: versionInfo });
});
app.get('/api/versions', (req, res) => {
  const meta = getVersions();
  meta.versions.forEach(v => {
    const vDir = path.join(VERSIONS_DIR, v.id);
    if (fs.existsSync(vDir)) { const r = runSync(`du -sh "${vDir}" 2>/dev/null`); v.size = r.ok ? r.output.split('\t')[0] : '?'; v.exists = true; }
    else { v.size = '0'; v.exists = false; }
  });
  res.json(meta);
});
app.post('/api/versions/:id/activate', (req, res) => {
  const meta = getVersions(); const version = meta.versions.find(v => v.id === req.params.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  const vDir = path.join(VERSIONS_DIR, req.params.id);
  if (!fs.existsSync(vDir)) return res.status(404).json({ error: 'Version files missing' });
  // Auto-snapshot current before switching
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); const autoId = 'v-auto-' + ts;
  const autoDir = path.join(VERSIONS_DIR, autoId); fs.mkdirSync(autoDir, { recursive: true });
  const dashDir = path.resolve(__dirname);
  function copyCurrentFiles(dir, prefix) { try { fs.readdirSync(dir).forEach(name => { if (name.startsWith('.') || name === 'node_modules') return; const fp = path.join(dir, name); const rel = prefix ? prefix + '/' + name : name; try { const s = fs.statSync(fp); if (s.isDirectory()) copyCurrentFiles(fp, rel); else { const dest = path.join(autoDir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(fp, dest); } } catch {} }); } catch {} }
  copyCurrentFiles(dashDir, '');
  if (!meta.versions.find(v => v.id === autoId)) meta.versions.push({ id: autoId, label: 'Auto-save before switching to ' + (version.label || req.params.id), timestamp: new Date().toISOString(), isBase: false, isAuto: true });
  function restoreFiles(dir, prefix) { try { fs.readdirSync(dir).forEach(name => { const fp = path.join(dir, name); const rel = prefix ? prefix + '/' + name : name; try { const s = fs.statSync(fp); if (s.isDirectory()) restoreFiles(fp, rel); else { const dest = path.join(dashDir, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(fp, dest); } } catch {} }); } catch {} }
  restoreFiles(vDir, '');
  meta.current = req.params.id; saveVersionsMeta(meta);
  res.json({ ok: true, message: 'Switched to ' + (version.label || req.params.id) + '. Restart dashboard to apply.', needsRestart: true });
});
app.delete('/api/versions/:id', (req, res) => {
  const meta = getVersions(); const idx = meta.versions.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Version not found' });
  if (meta.baseStable === req.params.id) return res.status(400).json({ error: 'Cannot delete base stable version' });
  if (meta.current === req.params.id) return res.status(400).json({ error: 'Cannot delete currently active version' });
  const vDir = path.join(VERSIONS_DIR, req.params.id);
  if (fs.existsSync(vDir)) runSync(`rm -rf "${vDir}"`);
  meta.versions.splice(idx, 1); saveVersionsMeta(meta);
  res.json({ ok: true });
});
app.put('/api/versions/:id', (req, res) => {
  const meta = getVersions(); const version = meta.versions.find(v => v.id === req.params.id);
  if (!version) return res.status(404).json({ error: 'Version not found' });
  if (req.body.label !== undefined) version.label = req.body.label;
  if (req.body.markAsBase !== undefined) { if (req.body.markAsBase) { meta.versions.forEach(v => { v.isBase = false; }); version.isBase = true; meta.baseStable = req.params.id; } else { version.isBase = false; if (meta.baseStable === req.params.id) meta.baseStable = null; } }
  saveVersionsMeta(meta); res.json({ ok: true, version });
});

// ═══ NEWS ═══
app.get('/api/news', (req, res) => {
  const news = loadNews(); const prefs = loadNewsPrefs();
  if (news.articles) {
    news.articles.forEach(a => { a.isQuality = prefs.quality.includes(a.url); a.isUseless = prefs.useless.includes(a.url); a.isBookmarked = prefs.bookmarks.some(b => b.url === a.url); });
    news.articles = news.articles.filter(a => !prefs.deletedUrls.includes(a.url));
  }
  news.prefs = { sources: prefs.sources, qualityCount: prefs.quality.length, bookmarkCount: prefs.bookmarks.length };
  res.json(news);
});
app.get('/api/news/bookmarks', (req, res) => res.json({ bookmarks: loadNewsPrefs().bookmarks }));
app.get('/api/news/quality', (req, res) => {
  const prefs = loadNewsPrefs(); const news = loadNews();
  const quality = (news.articles || []).filter(a => prefs.quality.includes(a.url) && !prefs.deletedUrls.includes(a.url));
  res.json({ articles: quality });
});
app.post('/api/news/feedback', (req, res) => {
  const { url, action } = req.body; if (!url || !action) return res.status(400).json({ error: 'url and action required' });
  const prefs = loadNewsPrefs(); const news = loadNews();
  const article = (news.articles || []).find(a => a.url === url);
  if (action === 'quality') { if (!prefs.quality.includes(url)) prefs.quality.push(url); prefs.useless = prefs.useless.filter(u => u !== url); }
  else if (action === 'unquality') prefs.quality = prefs.quality.filter(u => u !== url);
  else if (action === 'useless') { if (!prefs.useless.includes(url)) prefs.useless.push(url); prefs.quality = prefs.quality.filter(u => u !== url); }
  else if (action === 'unuseless') prefs.useless = prefs.useless.filter(u => u !== url);
  else if (action === 'bookmark') { if (!prefs.bookmarks.some(b => b.url === url)) prefs.bookmarks.push({ url, title: article?.title || url, source: article?.source, date: article?.date, savedAt: new Date().toISOString() }); }
  else if (action === 'unbookmark') prefs.bookmarks = prefs.bookmarks.filter(b => b.url !== url);
  else if (action === 'delete') { if (!prefs.deletedUrls.includes(url)) prefs.deletedUrls.push(url); }
  saveNewsPrefs(prefs); res.json({ ok: true });
});
app.put('/api/news/sources', (req, res) => {
  const prefs = loadNewsPrefs(); prefs.sources = Object.assign(prefs.sources || {}, req.body.sources);
  saveNewsPrefs(prefs); res.json({ ok: true, sources: prefs.sources });
});
app.post('/api/news/fetch', async (req, res) => {
  const random = req.body.random === true;
  const prefs = loadNewsPrefs();
  const sources = buildNewsSources(prefs, random);
  const articles = []; const seenUrls = new Set();

  for (const [key, src] of sources) {
    const r = await run(src.cmd, { timeout: 15000 });
    if (!r.ok) continue;
    try {
      if (src.type === 'hn') {
        const data = JSON.parse(r.output);
        if (data.hits) data.hits.forEach(hit => { const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`; if (seenUrls.has(url)) return; seenUrls.add(url); articles.push({ title: hit.title, url, source: src.name, author: hit.author, points: hit.points, comments: hit.num_comments, date: hit.created_at, hnLink: `https://news.ycombinator.com/item?id=${hit.objectID}`, sourceKey: key }); });
      } else if (src.type === 'github') {
        const data = JSON.parse(r.output);
        if (data.items) data.items.forEach(repo => { const url = repo.html_url; if (seenUrls.has(url)) return; seenUrls.add(url); articles.push({ title: `${repo.full_name}: ${(repo.description || '').slice(0, 150)}`, url, source: src.name, author: repo.owner?.login, points: repo.stargazers_count, date: repo.updated_at, isRepo: true, sourceKey: key }); });
      } else if (src.type === 'reddit') {
        const data = JSON.parse(r.output);
        if (data?.data?.children) data.data.children.forEach(c => { const p = c.data; if (!p || p.stickied) return; const url = p.url || `https://reddit.com${p.permalink}`; if (seenUrls.has(url)) return; seenUrls.add(url); articles.push({ title: p.title, url, source: src.name, author: p.author, points: p.score, comments: p.num_comments, date: new Date(p.created_utc * 1000).toISOString(), redditLink: `https://reddit.com${p.permalink}`, sourceKey: key }); });
      } else if (src.type === 'arxiv') {
        const entries = r.output.match(/<entry>([\s\S]*?)<\/entry>/g) || [];
        entries.forEach(entry => {
          const title = (entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim();
          const link = (entry.match(/<id>([\s\S]*?)<\/id>/) || [])[1]?.trim();
          const published = (entry.match(/<published>([\s\S]*?)<\/published>/) || [])[1]?.trim();
          const author = (entry.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.trim();
          if (title && link && !seenUrls.has(link)) { seenUrls.add(link); articles.push({ title: `[Paper] ${title}`, url: link, source: src.name, author, date: published, isPaper: true, sourceKey: key }); }
        });
      }
    } catch {}
  }

  // Sort with quality boost
  if (!random && prefs.quality.length > 0) {
    const qualitySourceKeys = new Set();
    const oldNews = loadNews();
    (oldNews.articles || []).forEach(a => { if (prefs.quality.includes(a.url) && a.sourceKey) qualitySourceKeys.add(a.sourceKey); });
    articles.forEach(a => { if (qualitySourceKeys.has(a.sourceKey)) a.boosted = true; });
    articles.sort((a, b) => { if (a.boosted && !b.boosted) return -1; if (!a.boosted && b.boosted) return 1; return new Date(b.date || 0) - new Date(a.date || 0); });
  } else { articles.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)); }

  const news = { articles: articles.slice(0, 60), lastFetched: new Date().toISOString(), fetchCount: articles.length, isRandom: random, sourcesUsed: sources.map(([, s]) => s.name) };
  saveNews(news); res.json(news);
});
app.delete('/api/news', (req, res) => { saveNews({ articles: [], lastFetched: null }); res.json({ ok: true }); });
app.put('/api/news', (req, res) => {
  const { articles } = req.body;
  if (!Array.isArray(articles)) return res.status(400).json({ error: 'articles array required' });
  const news = { articles, lastFetched: new Date().toISOString(), fetchCount: articles.length };
  saveNews(news); res.json(news);
});

// ═══ ANTFARM ═══
app.get('/api/antfarm/status', async (req, res) => {
  const i = await run('which antfarm 2>/dev/null');
  if (!i.ok || !i.output) return res.json({ installed: false });
  const wf = await run('antfarm workflow list 2>/dev/null');
  const wl = []; if (wf.ok) wf.output.split('\n').forEach(l => { const m = l.match(/^\s+(\S+)/); if (m && !l.includes('Available')) wl.push(m[1]); });
  res.json({ installed: true, workflows: wl, runsCount: getAntfarmRuns().length });
});
app.get('/api/antfarm/runs', (req, res) => res.json({ runs: getAntfarmRuns() }));
app.post('/api/antfarm/run', async (req, res) => {
  const { workflow, task } = req.body;
  if (!task) return res.status(400).json({ error: 'task required' });
  if (workflow) {
    const r = await run(`antfarm workflow run ${workflow} "${task.replace(/"/g, '\\"')}" 2>/dev/null`, { timeout: 30000 });
    const runRecord = { id: `run-${Date.now()}`, task, workflow, status: r.ok ? 'completed' : 'failed', createdAt: new Date().toISOString(), output: cleanCli(r.output) };
    const runs = getAntfarmRuns(); runs.unshift(runRecord); saveAntfarmRuns(runs.slice(0, 100));
    return res.json({ ok: r.ok, run: runRecord, output: cleanCli(r.output) });
  }
  const runRecord = { id: `run-${Date.now()}`, task, status: 'queued', createdAt: new Date().toISOString(), output: 'Queued. Install antfarm globally for live execution.' };
  const runs = getAntfarmRuns(); runs.unshift(runRecord); saveAntfarmRuns(runs.slice(0, 100));
  res.json({ ok: true, run: runRecord });
});
app.get('/api/antfarm/version', async (req, res) => {
  const cur = await run('antfarm --version 2>/dev/null');
  const latest = await run('npm show antfarm version 2>/dev/null', { timeout: 20000 });
  res.json({ current: cur.ok ? cur.output : null, latest: latest.ok ? latest.output : null, updateAvailable: cur.ok && latest.ok && cur.output !== latest.output, installed: cur.ok });
});
app.post('/api/antfarm/update', async (req, res) => {
  const r = await run('npm install -g antfarm@latest', { timeout: 120000 });
  const v = await run('antfarm --version 2>/dev/null');
  res.json({ ok: r.ok, version: v.output, output: cleanCli(r.output) });
});
app.post('/api/antfarm/rollback', async (req, res) => {
  const { version } = req.body; if (!version || !/^[\d.]+$/.test(version)) return res.status(400).json({ error: 'Valid version required' });
  const r = await run(`npm install -g antfarm@${version}`, { timeout: 120000 });
  const v = await run('antfarm --version 2>/dev/null');
  res.json({ ok: r.ok, version: v.output, output: cleanCli(r.output) });
});
app.post('/api/antfarm/dashboard/:action', async (req, res) => {
  const r = await run(`antfarm dashboard ${req.params.action} 2>/dev/null`);
  res.json({ ok: r.ok, output: cleanCli(r.output) });
});

// ═══ SETTINGS / QUICK-ENABLE ═══
app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => { saveSettings(req.body || {}); res.json({ ok: true, settings: getSettings() }); });
app.post('/api/openai/quick-enable', (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim(); const oauth = !!req.body?.oauth;
  if (!apiKey && !oauth) return res.status(400).json({ ok: false, error: 'Provide apiKey or oauth=true' });
  saveSettings({ openaiApiKey: apiKey || getSettings().openaiApiKey || '', openaiOAuthEnabled: oauth });
  const skills = getSkills().map(s => s.id === 'openai-auth' ? { ...s, installed: true, enabled: true } : s); saveSkills(skills);
  const out = applySettingsToConfigFile();
  res.json({ ok: true, message: 'OpenAI quick-connect enabled', settings: getSettings(), backup: out.backup });
});
app.post('/api/telegram/quick-enable', (req, res) => {
  const botToken = String(req.body?.botToken || '').trim();
  if (!botToken || !botToken.includes(':')) return res.status(400).json({ ok: false, error: 'Invalid Telegram bot token format' });
  saveSettings({ telegramBotToken: botToken });
  const skills = getSkills().map(s => s.id === 'telegram-setup' ? { ...s, installed: true, enabled: true } : s); saveSkills(skills);
  const out = applySettingsToConfigFile();
  res.json({ ok: true, message: 'Telegram quick-connect enabled', backup: out.backup });
});
app.get('/api/settings/export', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="quickclaw-settings.json"'); res.send(JSON.stringify({ exportedAt: new Date().toISOString(), settings: getSettings() }, null, 2)); });
app.post('/api/settings/import', (req, res) => { saveSettings(req.body?.settings || req.body || {}); res.json({ ok: true, settings: getSettings() }); });
app.get('/api/skills', (req, res) => res.json({ skills: getSkills() }));
app.post('/api/skills/toggle', (req, res) => { const { id, enabled } = req.body || {}; const list = getSkills().map(s => s.id === id ? { ...s, enabled: !!enabled } : s); saveSkills(list); res.json({ ok: true, skills: list }); });
app.post('/api/skills/install', (req, res) => { const { id } = req.body || {}; const list = getSkills().map(s => s.id === id ? { ...s, installed: true } : s); saveSkills(list); res.json({ ok: true, skills: list }); });

// ═══ MEMORY ═══
app.get('/api/memory/files', (req, res) => {
  try { const dir = path.join(ROOT, 'memory'); if (!fs.existsSync(dir)) return res.json({ files: [] }); const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse(); res.json({ files: files.map(f => path.join(dir, f)) }); }
  catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/api/memory/file', (req, res) => { try { const p = ensureWithinRoot(req.query.path || ''); res.json({ ok: true, path: p, content: fs.readFileSync(p, 'utf8') }); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); } });
app.put('/api/memory/file', (req, res) => { try { const p = ensureWithinRoot(req.body?.path || ''); fs.writeFileSync(p, req.body?.content || '', 'utf8'); res.json({ ok: true, path: p }); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); } });
app.post('/api/memory/create', (req, res) => {
  try { const name = String(req.body?.name || '').trim(); if (!name) return res.status(400).json({ ok: false, error: 'name is required' }); const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_'); const dir = path.join(ROOT, 'memory'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, safe.endsWith('.md') ? safe : `${safe}.md`); if (!fs.existsSync(file)) fs.writeFileSync(file, req.body?.content || `# ${safe}\n`, 'utf8'); res.json({ ok: true, path: file }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/api/memory/export', (req, res) => {
  const files = []; const memDir = path.join(ROOT, 'memory');
  if (fs.existsSync(memDir)) for (const f of fs.readdirSync(memDir).filter(x => x.endsWith('.md'))) { const p = path.join(memDir, f); files.push({ path: p, content: fs.readFileSync(p, 'utf8') }); }
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="quickclaw-memory-export.json"');
  res.send(JSON.stringify({ exportedAt: new Date().toISOString(), files, profiles: getProfiles() }, null, 2));
});

// ═══ CHAT ═══
app.get('/api/chat/history', (req, res) => res.json({ messages: getChatHistory().slice(-100) }));
app.post('/api/chat/send', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
  const rows = getChatHistory(); rows.push({ role: 'user', text, at: new Date().toISOString() });
  let reply = 'Got it. I saved this in local chat history.';
  if (text.toLowerCase().includes('openai')) reply = 'Use Integrations tab → OpenAI key + Quick Connect.';
  if (text.toLowerCase().includes('memory')) reply = 'Use Memory tab to create/edit files.';
  rows.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
  saveChatHistory(rows.slice(-300)); res.json({ ok: true, reply, messages: rows.slice(-40) });
});

// ═══ AUTH / OAUTH ═══
app.get('/api/profiles/:id/auth', (req, res) => {
  const pp = profilePaths(req.params.id);
  const st = getSettings();
  const env = fs.existsSync(pp.envPath) ? readEnv(pp.envPath) : {};
  const hasApiKey = !!(env.OPENAI_API_KEY || st.openaiApiKey);
  const hasOAuthToken = !!(env.OPENAI_OAUTH_TOKEN || env.OPENAI_CODEX_TOKEN || st.openaiOAuthEnabled);
  const oauthExpiry = env.OPENAI_OAUTH_EXPIRY || env.OPENAI_CODEX_EXPIRY || st.openaiOAuthExpiry || null;
  const envMethod = env.OPENAI_AUTH_METHOD || null;
  const method = envMethod || (hasOAuthToken ? 'codex-oauth' : (hasApiKey ? 'api-key' : 'none'));
  res.json({ method, hasApiKey, hasOAuthToken, oauthExpiry, oauthValid: hasOAuthToken && (!oauthExpiry || new Date(oauthExpiry) > new Date()), oauthConnectedAt: st.openaiOAuthConnectedAt || null, openai: { oauthEnabled: hasOAuthToken, hasApiKey }, anthropic: { hasApiKey: !!st.anthropicApiKey } });
});

const oauthSessions = {};
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const CODEX_AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

app.post('/api/profiles/:id/auth/oauth/start', (req, res) => {
  const id = req.params.id;
  const clientId = req.body.clientId || getSettings().openaiOAuthClientId || CODEX_CLIENT_ID;
  const redirectUri = req.body.redirectUri || CODEX_REDIRECT_URI;
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(32).toString('hex');
  const authUrl = CODEX_AUTH_ENDPOINT + '?' + 'client_id=' + encodeURIComponent(clientId) + '&redirect_uri=' + encodeURIComponent(redirectUri) + '&response_type=code' + '&scope=' + encodeURIComponent('openid profile email offline_access') + '&code_challenge=' + codeChallenge + '&code_challenge_method=S256' + '&id_token_add_organizations=true' + '&state=' + state;
  oauthSessions[id] = { codeVerifier, clientId, redirectUri, state, startedAt: new Date().toISOString() };
  saveSettings({ openaiOAuthClientId: clientId, openaiOAuthLastState: state, openaiOAuthPkceVerifier: codeVerifier, openaiOAuthRedirectUri: redirectUri });
  res.json({ success: true, authUrl, state });
});

app.post('/api/profiles/:id/auth/oauth/complete', async (req, res) => {
  const id = req.params.id;
  const session = oauthSessions[id];
  if (!session) return res.status(400).json({ error: 'No active OAuth session — click Start first' });
  const { callbackUrl, code: directCode } = req.body;
  let code = directCode;
  if (!code && callbackUrl) { try { code = new URL(callbackUrl).searchParams.get('code'); } catch {} if (!code) { const m = callbackUrl.match(/[?&]code=([^&]+)/); if (m) code = m[1]; } }
  if (!code) return res.status(400).json({ error: 'Could not extract authorization code.' });
  try {
    const https = require('https');
    const tokenData = await new Promise((resolve, reject) => {
      const postData = new URLSearchParams({ grant_type: 'authorization_code', client_id: session.clientId, code, redirect_uri: session.redirectUri, code_verifier: session.codeVerifier }).toString();
      const req = https.request(CODEX_TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } }, (resp) => {
        let body = ''; resp.on('data', c => body += c);
        resp.on('end', () => { try { const j = JSON.parse(body); if (j.error) reject(new Error(j.error_description || j.error)); else resolve(j); } catch { reject(new Error('Invalid response')); } });
      });
      req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timed out')); }); req.write(postData); req.end();
    });
    // Save tokens
    const pp = profilePaths(id);
    if (fs.existsSync(pp.envPath)) {
      const env = readEnv(pp.envPath);
      if (tokenData.access_token) { env.OPENAI_OAUTH_TOKEN = tokenData.access_token; env.OPENAI_CODEX_TOKEN = tokenData.access_token; }
      if (tokenData.refresh_token) { env.OPENAI_OAUTH_REFRESH = tokenData.refresh_token; env.OPENAI_CODEX_REFRESH = tokenData.refresh_token; }
      if (tokenData.expires_in) { const exp = new Date(Date.now() + tokenData.expires_in * 1000).toISOString(); env.OPENAI_OAUTH_EXPIRY = exp; env.OPENAI_CODEX_EXPIRY = exp; }
      env.OPENAI_AUTH_METHOD = 'codex-oauth'; writeEnv(pp.envPath, env);
    }
    saveSettings({ openaiOAuthEnabled: true, openaiOAuthConnectedAt: new Date().toISOString() });
    // Save to ~/.codex/auth.json
    try { const codexDir = path.join(HOME, '.codex'); fs.mkdirSync(codexDir, { recursive: true }); fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token || '', id_token: tokenData.id_token || '', expires: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : 0 }, null, 2)); } catch {}
    delete oauthSessions[id];
    res.json({ success: true, message: 'OAuth connected! Tokens saved.', expiresIn: tokenData.expires_in });
  } catch (err) { res.status(400).json({ error: 'Token exchange failed: ' + err.message }); }
});

app.get('/api/profiles/:id/auth/oauth/status', (req, res) => { const s = oauthSessions[req.params.id]; res.json({ active: !!s, startedAt: s?.startedAt || null }); });
app.post('/api/profiles/:id/auth/oauth/manual', (req, res) => {
  const { accessToken, refreshToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) {
    const env = readEnv(pp.envPath); env.OPENAI_OAUTH_TOKEN = accessToken; env.OPENAI_CODEX_TOKEN = accessToken;
    if (refreshToken) { env.OPENAI_OAUTH_REFRESH = refreshToken; env.OPENAI_CODEX_REFRESH = refreshToken; }
    env.OPENAI_AUTH_METHOD = 'codex-oauth'; writeEnv(pp.envPath, env);
  }
  saveSettings({ openaiOAuthEnabled: true });
  res.json({ success: true, message: 'Tokens saved.' });
});
app.post('/api/profiles/:id/auth/toggle', (req, res) => {
  const method = req.body?.method || 'api-key';
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) { const env = readEnv(pp.envPath); env.OPENAI_AUTH_METHOD = method; writeEnv(pp.envPath, env); }
  saveSettings({ openaiOAuthEnabled: method === 'codex-oauth' });
  res.json({ success: true, message: `Auth mode switched to ${method}` });
});
app.post('/api/profiles/:id/auth/oauth/revoke', (req, res) => {
  const pp = profilePaths(req.params.id);
  if (fs.existsSync(pp.envPath)) {
    const env = readEnv(pp.envPath);
    ['OPENAI_OAUTH_TOKEN', 'OPENAI_CODEX_TOKEN', 'OPENAI_OAUTH_REFRESH', 'OPENAI_CODEX_REFRESH', 'OPENAI_OAUTH_EXPIRY', 'OPENAI_CODEX_EXPIRY', 'OPENAI_AUTH_METHOD'].forEach(k => delete env[k]);
    writeEnv(pp.envPath, env);
  }
  saveSettings({ openaiOAuthEnabled: false, openaiOAuthConnectedAt: null });
  res.json({ success: true, message: 'OAuth revoked.' });
});
app.post('/api/profiles/:id/auth/oauth/share', (req, res) => res.json({ success: true, message: 'OAuth sharing: copy .env tokens between profiles manually in local mode.' }));
app.post('/api/profiles/:id/auth/oauth/cancel', (req, res) => { delete oauthSessions[req.params.id]; res.json({ success: true }); });

// ═══ OAUTH CALLBACK PAGE ═══
app.get('/oauth/callback', (req, res) => {
  const code = String(req.query.code || ''); const state = String(req.query.state || '');
  const err = String(req.query.error || ''); const desc = String(req.query.error_description || '');
  if (err) return res.redirect(`/?tab=auth&oauthError=${encodeURIComponent(err + (desc ? ': ' + desc : ''))}`);
  const callbackUrl = `http://localhost:${PORT}/oauth/callback?` + new URLSearchParams(req.query).toString();
  const q = new URLSearchParams({ tab: 'auth', oauthCallback: callbackUrl, oauthCode: code, oauthState: state });
  return res.redirect('/?' + q.toString() + '#auth');
});
app.get('/oauth/start-codex', (req, res) => {
  const profile = String(req.query.profile || 'default');
  const localCmd = `${LOCAL_OPENCLAW} onboard --auth-choice openai-codex`;
  const globalCmd = 'openclaw onboard --auth-choice openai-codex';
  const cmd = `(${globalCmd}) || (${localCmd})`;
  let launched = false;
  try { if (process.platform === 'darwin') { execSync(`osascript -e 'tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"'`, { stdio: 'ignore' }); launched = true; } } catch {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>OpenAI Connect</title><style>body{font-family:system-ui;background:#0f1115;color:#e7e9ee;padding:24px;max-width:820px;margin:0 auto}code{background:#1a1f2a;padding:4px 8px;border-radius:6px}.card{background:#161b22;border:1px solid #2d333b;border-radius:12px;padding:16px;margin:12px 0}.btn{display:inline-block;background:#1f6feb;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none}</style></head><body><h2>Connect OpenAI</h2><div class="card"><p>${launched ? 'Terminal opened. Complete login there.' : 'Run this command in Terminal:'}</p><code>${cmd}</code></div><div class="card"><a class="btn" href="http://localhost:${PORT}/?tab=auth&oauth=codex&profile=${encodeURIComponent(profile)}#auth">I finished login</a> <a style="margin-left:10px" href="http://localhost:${PORT}">Back to Dashboard</a></div></body></html>`);
});

// ═══ PROFILE CATCH-ALL (safety net) ═══
app.post('/api/profiles/:id/:action', (req, res) => res.json({ ok: true, action: req.params.action, id: req.params.id }));
app.all('/api/profiles/:id/*', (req, res) => {
  const sub = req.params[0] || '';
  if (sub.startsWith('files')) return res.json({ files: [], dir: null });
  if (sub.startsWith('history')) return res.json({ items: [], sessions: [] });
  if (sub.startsWith('memory')) return res.json({ items: [] });
  if (sub.startsWith('keys')) return res.json({ keys: [] });
  if (sub.startsWith('usage')) return res.json({ totals: { cost: 0, input: 0, output: 0 }, byModel: {}, byDay: [], noData: true });
  if (sub.startsWith('config')) return res.json({ config: {} });
  if (sub.startsWith('soul')) return res.json({ content: '' });
  if (sub.startsWith('skills')) return res.json({ skills: getSkills() });
  if (sub.startsWith('logs')) return res.json({ logs: '' });
  if (sub.startsWith('auth')) return res.json({ openai: { oauthEnabled: false, hasApiKey: false } });
  if (sub.startsWith('channel')) return res.json({ enabled: false });
  return res.json({ ok: true, note: 'profile endpoint stub', path: sub });
});

// API safety net
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'API endpoint not implemented', path: req.path, method: req.method }));

// Catch-all → SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`\n⚡ OpenClaw Command Center v2.5 (QuickClaw) | Port ${PORT}\nDashboard: http://localhost:${PORT}\n`));
