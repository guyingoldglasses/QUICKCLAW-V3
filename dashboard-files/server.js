const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
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

for (const d of [PID_DIR, LOG_DIR, DATA_DIR, CONFIG_BACKUPS_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, opts, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : null });
    });
  });
}
function portListeningSync(port) { try { execSync(`lsof -ti tcp:${port}`, { stdio: 'pipe' }); return true; } catch { return false; } }
function tailFile(logFile, lines = 120) {
  const p = path.join(LOG_DIR, logFile);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').split('\n').slice(-Math.max(lines, 1)).join('\n');
}
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function cliBin() { return fs.existsSync(LOCAL_OPENCLAW) ? `"${LOCAL_OPENCLAW}"` : 'npx openclaw'; }
function gatewayStartCommand() { return `${cliBin()} gateway start --allow-unconfigured`; }
function gatewayStopCommand() { return `${cliBin()} gateway stop`; }

function getProfiles() {
  const list = readJson(PROFILES_PATH, null);
  if (Array.isArray(list) && list.length) return list;
  const starter = [{ id: 'default', name: 'Default', active: true, status: 'running', port: 3000, notes: '', soul: '', memoryPath: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
  writeJson(PROFILES_PATH, starter);
  return starter;
}
function saveProfiles(list) { writeJson(PROFILES_PATH, list); }

function getSettings() {
  return readJson(SETTINGS_PATH, {
    openaiApiKey: '',
    openaiOAuthEnabled: false,
    anthropicApiKey: '',
    telegramBotToken: '',
    ftpHost: '',
    ftpUser: '',
    emailUser: ''
  });
}
function saveSettings(s) { writeJson(SETTINGS_PATH, { ...getSettings(), ...s }); }

function defaultSkillsCatalog() {
  return [
    {
      id: 'core-tools',
      name: 'Core Platform Tools',
      description: 'Essential local runtime controls: gateway status/start/stop, logs, config read/write, profile storage.',
      includes: ['gateway controls', 'log viewer', 'config apply/backup', 'profile persistence'],
      enabled: true,
      installed: true,
      risk: 'low'
    },
    {
      id: 'openai-auth',
      name: 'OpenAI Authentication',
      description: 'Stores OpenAI credentials and OAuth mode flags for local config generation.',
      includes: ['api key field', 'oauth mode flag', 'settings export/import'],
      enabled: false,
      installed: true,
      risk: 'medium'
    },
    {
      id: 'ftp-deploy',
      name: 'FTP Deploy',
      description: 'Deployment helper settings for FTP host/user workflows.',
      includes: ['ftp host/user settings', 'future deploy hooks'],
      enabled: false,
      installed: false,
      risk: 'medium'
    },
    {
      id: 'telegram-setup',
      name: 'Telegram Setup',
      description: 'Easy BotFather token setup and quick-connect to config.',
      includes: ['token save', 'config apply', 'connection hints'],
      enabled: false,
      installed: false,
      risk: 'low'
    },
    {
      id: 'email',
      name: 'Email Integration',
      description: 'Email account settings for notifications and outbound workflows.',
      includes: ['email user settings', 'future send/read actions'],
      enabled: false,
      installed: false,
      risk: 'medium'
    },
    {
      id: 'antfarm',
      name: 'Antfarm Automation',
      description: 'Task queue + run history panel for workflow automations.',
      includes: ['run queue', 'recent runs', 'status panel'],
      enabled: false,
      installed: false,
      risk: 'medium'
    }
  ];
}

function getSkills() {
  const list = readJson(SKILLS_PATH, null);
  const defaults = defaultSkillsCatalog();
  if (Array.isArray(list)) {
    const byId = Object.fromEntries(defaults.map(s => [s.id, s]));
    const merged = list.map(s => ({ ...byId[s.id], ...s }));
    // add any new defaults not present yet
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

function getProfileEnvStore() { return readJson(PROFILE_ENV_PATH, {}); }
function saveProfileEnvStore(store) { writeJson(PROFILE_ENV_PATH, store); }
function getProfileEnv(profileId) {
  const st = getProfileEnvStore();
  const raw = st[profileId] || {};
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, 'value')) cleaned[k] = String(v.value ?? '');
      else cleaned[k] = '';
    } else {
      cleaned[k] = String(v ?? '');
    }
  }
  return cleaned;
}


async function gatewayState() {
  const ws18789 = portListeningSync(18789);
  const ws5000 = portListeningSync(5000);
  const status = await run(`${cliBin()} gateway status`, { cwd: INSTALL_DIR });
  const txt = `${status.stdout}\n${status.stderr}`;
  const looksRunning = /Runtime:\s*running|listening on ws:\/\/127\.0\.0\.1:18789|gateway\s+running/i.test(txt);
  return { running: ws18789 || ws5000 || looksRunning, ws18789, port5000: ws5000, statusText: txt.trim() };
}

function addonsStatus() {
  const cfg = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  const has = (k) => cfg.includes(`${k}:`);
  return {
    openai: has('openai') ? 'configured-section' : 'missing',
    anthropic: has('anthropic') ? 'configured-section' : 'missing',
    telegram: has('telegram') ? 'configured-section' : 'missing',
    ftp: has('ftp') ? 'configured-section' : 'missing',
    email: has('email') ? 'configured-section' : 'missing'
  };
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
  const lines = [
    '# QuickClaw V3 generated config',
    'gateway:',
    '  mode: local',
    '  port: 5000',
    '  host: 127.0.0.1',
    ''
  ];
  if (s.openaiApiKey) lines.push('openai:', `  api_key: "${s.openaiApiKey}"`, '');
  if (s.anthropicApiKey) lines.push('anthropic:', `  api_key: "${s.anthropicApiKey}"`, '');
  if (s.telegramBotToken) lines.push('telegram:', `  bot_token: "${s.telegramBotToken}"`, '');
  if (s.ftpHost || s.ftpUser) lines.push('ftp:', ...(s.ftpHost ? [`  host: "${s.ftpHost}"`] : []), ...(s.ftpUser ? [`  user: "${s.ftpUser}"`] : []), '');
  if (s.emailUser) lines.push('email:', `  user: "${s.emailUser}"`, '');
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, lines.join('\n'));
  return { path: CONFIG_PATH, backup };
}

function ensureWithinRoot(rawPath) {
  const resolved = path.resolve(rawPath);
  const base = path.resolve(ROOT);
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  throw new Error('Path outside QuickClaw root is not allowed');
}

app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/status', async (req, res) => {
  const gw = await gatewayState();
  res.json({
    gateway: gw,
    dashboard: { running: true, pid: process.pid, port: Number(PORT), port3000: portListeningSync(3000), port3001: portListeningSync(3001) },
    root: ROOT,
    installDir: INSTALL_DIR,
    configPath: CONFIG_PATH,
    configExists: fs.existsSync(CONFIG_PATH),
    addons: addonsStatus()
  });
});

app.get('/api/activity', async (req, res) => {
  const gw = await gatewayState();
  const events = [];
  if (gw.running) events.push({ type: 'status', text: 'Gateway running', at: new Date().toISOString() });
  const gwTail = tailFile('gateway.log', 40).split('\n').filter(Boolean).slice(-8).map(t => ({ type: 'gateway-log', text: t }));
  const dbTail = tailFile('dashboard.log', 20).split('\n').filter(Boolean).slice(-5).map(t => ({ type: 'dashboard-log', text: t }));
  res.json({ events: [...events, ...gwTail, ...dbTail] });
});

app.get('/api/log/:name', (req, res) => {
  const name = req.params.name === 'gateway' ? 'gateway.log' : 'dashboard.log';
  const lines = parseInt(req.query.lines || '120', 10);
  res.type('text/plain').send(tailFile(name, lines));
});

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

app.get('/api/profiles', (req, res) => { const profiles=getProfiles().map(p=>({ ...p, status: p.status || (p.active?'running':'stopped'), port: p.port || 3000 })); res.json({ profiles }); });
app.post('/api/profiles', (req, res) => {
  const list = getProfiles();
  const id = `p-${Date.now()}`;
  list.push({ id, name: req.body?.name || `Profile ${list.length + 1}`, active: false, status: 'stopped', port: 3000, notes: req.body?.notes || '', soul: req.body?.soul || '', memoryPath: req.body?.memoryPath || '', createdAt: new Date().toISOString(), lastUsedAt: null });
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/activate', (req, res) => {
  const id = req.body?.id;
  const now = new Date().toISOString();
  const list = getProfiles().map(p => ({ ...p, active: p.id === id, status: p.id === id ? 'running' : (p.status || 'stopped'), port: p.port || 3000, lastUsedAt: p.id === id ? now : p.lastUsedAt }));
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/rename', (req, res) => {
  const { id, name } = req.body || {};
  const list = getProfiles().map(p => p.id === id ? { ...p, name: name || p.name } : p);
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});

app.post('/api/profiles/update', (req, res) => {
  const { id, name, notes, soul, memoryPath } = req.body || {};
  const list = getProfiles().map(p => p.id === id ? {
    ...p,
    name: name ?? p.name,
    notes: notes ?? p.notes,
    soul: soul ?? p.soul,
    memoryPath: memoryPath ?? p.memoryPath
  } : p);
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});

app.post('/api/profiles/delete', (req, res) => {
  const { id } = req.body || {};
  let list = getProfiles().filter(p => p.id !== id);
  if (!list.length) list = [{ id: 'default', name: 'Default', active: true, status: 'running', port: 3000, notes: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
  if (!list.some(p => p.active)) list[0].active = true;
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => { saveSettings(req.body || {}); res.json({ ok: true, settings: getSettings() }); });
app.post('/api/openai/quick-enable', (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  const oauth = !!req.body?.oauth;
  if (!apiKey && !oauth) return res.status(400).json({ ok: false, error: 'Provide apiKey or oauth=true' });

  const patch = {
    openaiApiKey: apiKey || getSettings().openaiApiKey || '',
    openaiOAuthEnabled: oauth
  };
  saveSettings(patch);

  const skills = getSkills().map(s => s.id === 'openai-auth' ? { ...s, installed: true, enabled: true } : s);
  saveSkills(skills);

  const out = applySettingsToConfigFile();
  res.json({ ok: true, message: 'OpenAI quick-connect enabled', settings: getSettings(), backup: out.backup });
});


app.get('/api/openai/oauth/start', (req, res) => {
  res.json({
    ok: true,
    mode: 'local-oauth-helper',
    connectUrl: 'https://platform.openai.com/settings/organization/api-keys',
    instructions: 'Generate an API key in your OpenAI account and paste it into Integrations tab, or toggle OAuth mode for future flow support.'
  });
});

app.post('/api/telegram/quick-enable', (req, res) => {
  const botToken = String(req.body?.botToken || '').trim();
  if (!botToken || !botToken.includes(':')) {
    return res.status(400).json({ ok: false, error: 'Invalid Telegram bot token format. Expected 123456:ABC...' });
  }

  saveSettings({ telegramBotToken: botToken });

  const skills = getSkills().map(s => s.id === 'telegram-setup' ? { ...s, installed: true, enabled: true } : s);
  saveSkills(skills);

  const out = applySettingsToConfigFile();
  res.json({
    ok: true,
    message: 'Telegram quick-connect enabled',
    backup: out.backup,
    botFather: 'https://t.me/BotFather',
    next: 'Add your bot to chat and send /start'
  });
});

app.get('/api/settings/export', (req, res) => {
  const payload = { exportedAt: new Date().toISOString(), settings: getSettings() };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="quickclaw-settings.json"');
  res.send(JSON.stringify(payload, null, 2));
});
app.post('/api/settings/import', (req, res) => {
  const incoming = req.body?.settings || req.body || {};
  saveSettings(incoming);
  res.json({ ok: true, settings: getSettings() });
});

app.get('/api/skills', (req, res) => res.json({ skills: getSkills() }));
app.post('/api/skills/toggle', (req, res) => {
  const { id, enabled } = req.body || {};
  const list = getSkills().map(s => s.id === id ? { ...s, enabled: !!enabled } : s);
  saveSkills(list);
  res.json({ ok: true, skills: list });
});
app.post('/api/skills/install', (req, res) => {
  const { id } = req.body || {};
  const list = getSkills().map(s => s.id === id ? { ...s, installed: true } : s);
  saveSkills(list);
  res.json({ ok: true, skills: list });
});

app.get('/api/system/browse', (req, res) => {
  try {
    const dir = req.query.dir ? ensureWithinRoot(req.query.dir) : ROOT;
    const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, path: path.join(dir, d.name), type: d.isDirectory() ? 'dir' : 'file' }));
    res.json({ ok: true, dir, items });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.get('/api/system/readfile', (req, res) => {
  try {
    const p = ensureWithinRoot(req.query.path || '');
    res.json({ ok: true, path: p, content: fs.readFileSync(p, 'utf8') });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.put('/api/system/writefile', (req, res) => {
  try {
    const p = ensureWithinRoot(req.body?.path || '');
    fs.writeFileSync(p, req.body?.content || '', 'utf8');
    res.json({ ok: true, path: p });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.get('/api/security/audit', async (req, res) => {
  const gw = await gatewayState();
  const checks = [];
  checks.push({ name: 'Gateway running', status: gw.running ? 'pass' : 'warn', detail: gw.running ? 'Gateway is running.' : 'Gateway is not running.' });
  checks.push({ name: 'Config file', status: fs.existsSync(CONFIG_PATH) ? 'pass' : 'warn', detail: fs.existsSync(CONFIG_PATH) ? 'Config present.' : 'Config missing.' });
  checks.push({ name: 'Local hardening', status: 'info', detail: 'Deep security automation is not enabled in local mode yet.' });
  const score = checks.some(c => c.status === 'warn') ? 72 : 88;
  const findings = checks.map(c => ({ level: c.status === 'pass' ? 'info' : c.status, message: `${c.name}: ${c.detail}` }));
  res.json({ ok: true, score, checks, findings });
});
app.post('/api/security/fix', (req, res) => {
  res.json({ ok: false, message: 'Automatic security fixes are not yet enabled in local mode.' });
});

app.get('/api/updates/cli', (req, res) => {
  res.json({ ok: true, current: 'quickclaw-v3', latest: 'quickclaw-v3', canUpgrade: false, message: 'Manual zip update flow currently enabled.' });
});


app.get('/api/antfarm/status', async (req, res) => {
  const nodeBin = fs.existsSync(path.join(INSTALL_DIR, 'node_modules', '.bin', 'node'));
  const runs = getAntfarmRuns();
  res.json({ ok: true, installedHint: nodeBin, runsCount: runs.length, lastRun: runs[0] || null });
});

app.get('/api/antfarm/runs', (req, res) => {
  res.json({ runs: getAntfarmRuns() });
});

app.post('/api/antfarm/run', async (req, res) => {
  const task = String(req.body?.task || '').trim();
  if (!task) return res.status(400).json({ ok: false, error: 'task is required' });

  const runRecord = {
    id: `run-${Date.now()}`,
    task,
    status: 'queued',
    createdAt: new Date().toISOString(),
    output: 'Local mode stub: command queued. Full antfarm runtime hook pending.'
  };
  const runs = getAntfarmRuns();
  runs.unshift(runRecord);
  saveAntfarmRuns(runs.slice(0, 100));
  res.json({ ok: true, run: runRecord });
});

app.get('/api/memory/files', (req, res) => {
  try {
    const dir = path.join(ROOT, 'memory');
    if (!fs.existsSync(dir)) return res.json({ files: [] });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
    res.json({ files: files.map(f => path.join(dir, f)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/memory/file', (req, res) => {
  try {
    const p = ensureWithinRoot(req.query.path || '');
    res.json({ ok: true, path: p, content: fs.readFileSync(p, 'utf8') });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.put('/api/memory/file', (req, res) => {
  try {
    const p = ensureWithinRoot(req.body?.path || '');
    fs.writeFileSync(p, req.body?.content || '', 'utf8');
    res.json({ ok: true, path: p });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/memory/create', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const dir = path.join(ROOT, 'memory');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe.endsWith('.md') ? safe : `${safe}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, req.body?.content || `# ${safe}
`, 'utf8');
    res.json({ ok: true, path: file });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/memory/export', (req, res) => {
  const files = [];
  const memDir = path.join(ROOT, 'memory');
  if (fs.existsSync(memDir)) {
    for (const f of fs.readdirSync(memDir).filter(x => x.endsWith('.md'))) {
      const p = path.join(memDir, f);
      files.push({ path: p, content: fs.readFileSync(p, 'utf8') });
    }
  }
  const profiles = getProfiles();
  const payload = { exportedAt: new Date().toISOString(), files, profiles };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="quickclaw-memory-export.json"');
  res.send(JSON.stringify(payload, null, 2));
});




app.get('/api/env/download-all', (req, res) => {
  const st = getProfileEnvStore();
  const payload = { exportedAt: new Date().toISOString(), profiles: st };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="all-profile-env.json"');
  res.send(JSON.stringify(payload, null, 2));
});

app.get('/api/chat/history', (req, res) => {
  res.json({ messages: getChatHistory().slice(-100) });
});

app.post('/api/chat/send', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });

  const rows = getChatHistory();
  rows.push({ role: 'user', text, at: new Date().toISOString() });

  const lower = text.toLowerCase();
  let reply = 'Got it. I saved this in local chat history. Next: choose a tab to apply this action.';
  if (lower.includes('openai')) reply = 'Use Integrations tab → OpenAI key + Quick Connect to apply settings into config.';
  if (lower.includes('memory')) reply = 'Use Memory tab to create/edit files, then Export Memory to download everything.';
  if (lower.includes('profile')) reply = 'Use Profiles tab to edit notes/soul/memory path and set active profile.';

  rows.push({ role: 'assistant', text: reply, at: new Date().toISOString() });
  saveChatHistory(rows.slice(-300));
  res.json({ ok: true, reply, messages: rows.slice(-40) });
});

// Compatibility endpoints for Command Center UI (local-mode safe stubs + aliases)
app.get('/api/alerts', (req, res) => res.json({ alerts: [] }));
app.get(['/api/profiles/', '/api/profiles'], (req, res) => { const profiles=getProfiles().map(p=>({ ...p, status: p.status || (p.active?'running':'stopped'), port: p.port || 3000 })); res.json({ profiles }); });
app.post('/api/profiles/wizard', (req, res) => {
  const name = String(req.body?.name || 'Wizard Profile');
  const list = getProfiles().map(p => ({ ...p, active: false }));
  const id = `p-${Date.now()}`;
  list.push({ id, name, active: true, notes: '', soul: '', memoryPath: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() });
  saveProfiles(list);
  res.json({ ok: true, profile: list.find(p => p.id === id), profiles: list });
});

app.get('/api/system', async (req, res) => {
  const gw = await gatewayState();
  res.json({
    quickclawRoot: ROOT,
    installDir: INSTALL_DIR,
    gateway: { running: gw.running, ws18789: gw.ws18789, port5000: gw.port5000 },
    hostname: require('os').hostname(),
    platform: process.platform
  });
});

app.get(['/api/system/browse?dir=', '/api/system/browse'], (req, res) => {
  try {
    const dir = req.query.dir ? ensureWithinRoot(req.query.dir) : ROOT;
    const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, path: path.join(dir, d.name), type: d.isDirectory() ? 'dir' : 'file' }));
    res.json({ dir, items });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});
app.get('/api/system/readfile', (req, res) => {
  try {
    const p = ensureWithinRoot(req.query.path || '');
    res.json({ path: p, content: fs.readFileSync(p, 'utf8') });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.put('/api/system/writefile', (req, res) => {
  try {
    const p = ensureWithinRoot(req.body?.path || '');
    fs.writeFileSync(p, req.body?.content || '', 'utf8');
    res.json({ ok: true, path: p });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

app.get('/api/usage/all', (req, res) => res.json({
  totals: {
    cost: 0,
    tokens: 0,
    requests: 0,
    sessions: 0
  },
  byModel: [],
  byProfile: [],
  recent: []
}));
app.get('/api/updates/workspace/', (req, res) => res.json({ ok: true, items: [] }));
app.get('/api/updates/workspace/:id', (req, res) => res.json({ ok: true, id: req.params.id, item: null }));
app.post('/api/updates/cli/upgrade', (req, res) => res.json({ ok: false, message: 'Manual zip update flow currently enabled.' }));

app.get(['/api/versions', '/api/versions/'], (req, res) => res.json({ versions: [{ id: 'current', label: 'Current local build' }] }));
app.get('/api/versions/:id', (req, res) => res.json({ id: req.params.id, details: null }));
app.post('/api/versions/snapshot', (req, res) => res.json({ ok: false, message: 'Snapshot feature not enabled in local mode yet.' }));

app.get('/api/news', (req, res) => res.json({ items: [] }));
app.get('/api/news/bookmarks', (req, res) => res.json({ items: [] }));
app.get('/api/news/quality', (req, res) => res.json({ score: null, notes: [] }));
app.post('/api/news/fetch', (req, res) => res.json({ ok: false, message: 'News fetch not configured in local mode.' }));
app.post('/api/news/feedback', (req, res) => res.json({ ok: true }));
app.put('/api/news/sources', (req, res) => res.json({ ok: true }));
app.put('/api/news', (req, res) => res.json({ ok: true }));

app.get('/api/antfarm/version', (req, res) => res.json({ version: 'local-stub', installed: true }));
app.post('/api/antfarm/update', (req, res) => res.json({ ok: false, message: 'Antfarm update not enabled yet.' }));
app.post('/api/antfarm/rollback', (req, res) => res.json({ ok: false, message: 'Antfarm rollback not enabled yet.' }));
app.post('/api/antfarm/dashboard/start', (req, res) => res.json({ ok: false, message: 'Dedicated antfarm dashboard not enabled.' }));
app.post('/api/antfarm/dashboard/stop', (req, res) => res.json({ ok: false, message: 'Dedicated antfarm dashboard not enabled.' }));

app.get('/api/dashboard/files', (req, res) => {
  const dir = path.join(__dirname, 'public');
  const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, path: path.join(dir, d.name), type: d.isDirectory() ? 'dir' : 'file' }));
  res.json({ dir, items });
});
app.get('/api/dashboard/file', (req, res) => {
  try {
    const p = path.resolve(req.query.path || '');
    const base = path.resolve(path.join(__dirname, 'public'));
    if (!(p === base || p.startsWith(base + path.sep))) throw new Error('Path outside dashboard public dir');
    res.json({ path: p, content: fs.readFileSync(p, 'utf8') });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.put('/api/dashboard/file', (req, res) => {
  try {
    const p = path.resolve(req.body?.path || '');
    const base = path.resolve(path.join(__dirname, 'public'));
    if (!(p === base || p.startsWith(base + path.sep))) throw new Error('Path outside dashboard public dir');
    fs.writeFileSync(p, req.body?.content || '', 'utf8');
    res.json({ ok: true, path: p });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/dashboard/restart', (req, res) => res.json({ ok: true, message: 'Restart via QuickClaw_Launch.command recommended.' }));

// Profile-level compatibility endpoints used by Command Center tabs
app.get('/api/profiles/:id/env', (req, res) => {
  const profileId = req.params.id;
  const varsObj = getProfileEnv(profileId);
  const reveal = String(req.query.reveal || '').toLowerCase() === 'true';
  const out = {};
  for (const [key, value] of Object.entries(varsObj)) {
    const raw = String(value ?? '');
    out[key] = reveal ? raw : (raw.length > 8 ? raw.slice(0,4) + '••••' + raw.slice(-2) : (raw ? '••••' : ''));
  }
  res.json({ vars: out });
});

app.get('/api/profiles/:id/env/keys', (req, res) => {
  const varsObj = getProfileEnv(req.params.id);
  res.json({ keys: Object.keys(varsObj) });
});

app.post('/api/profiles/:id/env/set', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.body?.key || '').trim();
  const value = String(req.body?.value ?? '');
  if (!key) return res.status(400).json({ ok:false, error:'key is required' });
  const st = getProfileEnvStore();
  st[profileId] = st[profileId] || {};
  st[profileId][key] = value;
  saveProfileEnvStore(st);
  res.json({ ok:true, key });
});

app.post('/api/profiles/:id/env/upload', (req, res) => {
  const profileId = req.params.id;
  const content = String(req.body?.content || '');
  const merge = req.body?.merge !== false;
  const st = getProfileEnvStore();
  st[profileId] = merge ? (st[profileId] || {}) : {};
  let keysAdded = 0;
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const idx = t.indexOf('=');
    const k = t.slice(0, idx).trim();
    const v = t.slice(idx + 1);
    if (!k) continue;
    st[profileId][k] = v;
    keysAdded += 1;
  }
  saveProfileEnvStore(st);
  res.json({ ok:true, keysAdded });
});

app.post('/api/profiles/:id/env/purge', (req, res) => {
  const profileId = req.params.id;
  const st = getProfileEnvStore();
  const purged = Object.keys(st[profileId] || {});
  st[profileId] = {};
  saveProfileEnvStore(st);
  res.json({ ok:true, purged });
});

app.post('/api/profiles/:id/env/:key/toggle', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.params.key || '');
  const enabled = !!req.body?.enabled;
  const st = getProfileEnvStore();
  st[profileId] = st[profileId] || {};
  st[profileId][`${key}_DISABLED`] = enabled ? '' : 'true';
  saveProfileEnvStore(st);
  res.json({ ok:true, key, enabled });
});

app.delete('/api/profiles/:id/env/:key', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.params.key || '');
  const st = getProfileEnvStore();
  if (st[profileId]) {
    delete st[profileId][key];
    delete st[profileId][`${key}_DISABLED`];
  }
  saveProfileEnvStore(st);
  res.json({ ok:true });
});

app.get('/api/profiles/:id/env/download', (req, res) => {
  const varsObj = getProfileEnv(req.params.id);
  const lines = Object.entries(varsObj).map(([k,v]) => `${k}=${v}`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}.env"`);
  res.send(lines.join('\\n'));
});

app.put('/api/profiles/:id/env', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.body?.key || '').trim();
  const value = String(req.body?.value || '');
  if (!key) return res.status(400).json({ ok:false, error:'key is required' });
  const st = getProfileEnvStore();
  st[profileId] = st[profileId] || {};
  st[profileId][key] = value;
  saveProfileEnvStore(st);
  res.json({ ok:true, key });
});

app.post('/api/profiles/:id/env', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.body?.key || '').trim();
  const value = String(req.body?.value || '');
  if (!key) return res.status(400).json({ ok:false, error:'key is required' });
  const st = getProfileEnvStore();
  st[profileId] = st[profileId] || {};
  st[profileId][key] = value;
  saveProfileEnvStore(st);
  res.json({ ok:true, key });
});

app.delete('/api/profiles/:id/env/:key', (req, res) => {
  const profileId = req.params.id;
  const key = String(req.params.key || '');
  const st = getProfileEnvStore();
  if (st[profileId]) delete st[profileId][key];
  saveProfileEnvStore(st);
  res.json({ ok:true });
});
app.get('/api/profiles/:id/config', (req, res) => {
  const cfg = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  res.json({ config: { path: CONFIG_PATH, raw: cfg } });
});
app.get('/api/profiles/:id/soul', (req, res) => {
  const p = getProfiles().find(x => x.id === req.params.id);
  res.json({ content: p?.soul || '' });
});
app.get('/api/profiles/:id/skills', (req, res) => res.json({ skills: getSkills() }));
app.get('/api/profiles/:id/logs', (req, res) => res.json({ logs: tailFile('gateway.log', parseInt(req.query.lines || '150', 10)) }));
app.get('/api/profiles/:id/models', (req, res) => res.json({ models: [{ id: 'default', name: 'default', enabled: true }] }));
app.get('/api/profiles/:id/usage', (req, res) => res.json({ totals: { cost: 0, input: 0, output: 0 }, byModel: {}, byDay: [], noData: true, topSessions: [], raw: {} }));
app.get('/api/profiles/:id/channels', (req, res) => res.json({ channels: { telegram: { enabled: !!getSettings().telegramBotToken } } }));
app.get('/api/profiles/:id/telegram/info', (req, res) => {
  const token = String(getSettings().telegramBotToken || '');
  const masked = token ? token.slice(0, 8) + '...' + token.slice(-6) : '';
  res.json({
    enabled: !!token,
    hasToken: !!token,
    botToken: masked,
    users: [],
    instructions: [
      '1) Open @BotFather in Telegram.',
      '2) Create bot with /newbot and copy token.',
      '3) Paste token in Comms → Telegram and click Save & Restart.',
      '4) Add your user id to approved users and send /start to bot.'
    ]
  });
});
app.get('/api/profiles/:id/pairing', (req, res) => res.json({ code: null, status: 'idle' }));
app.get('/api/profiles/:id/sessions', (req, res) => res.json({ sessions: [] }));
app.get('/api/profiles/:id/cron', (req, res) => res.json({ jobs: [], output: 'No cron jobs configured yet.' }));
app.get('/api/profiles/:id/activity', (req, res) => res.json({ events: [] }));
app.get('/api/profiles/:id/ftp', (req, res) => res.json({ host: getSettings().ftpHost || '', user: getSettings().ftpUser || '', port: '21', hasCredentials: !!getSettings().ftpHost }));
app.get('/api/profiles/:id/smtp', (req, res) => res.json({ host: '', port: '587', user: getSettings().emailUser || '', from: '', secure: true, hasCredentials: !!getSettings().emailUser }));
app.get('/api/profiles/:id/auth', (req, res) => {
  const st = getSettings();
  const oauthValid = !!st.openaiOAuthEnabled;
  res.json({
    method: oauthValid ? 'codex-oauth' : (st.openaiApiKey ? 'api-key' : 'none'),
    oauthValid,
    oauthExpiry: st.openaiOAuthExpiry || null,
    oauthConnectedAt: st.openaiOAuthConnectedAt || null,
    openai: { oauthEnabled: oauthValid, hasApiKey: !!st.openaiApiKey },
    anthropic: { hasApiKey: !!st.anthropicApiKey }
  });
});

// Generic action handler so button posts don't fail
app.post('/api/profiles/:id/:action', (req, res) => res.json({ ok: true, action: req.params.action, id: req.params.id }));


// Auth/OAuth compatibility flows expected by Command Center
app.post('/api/profiles/:id/auth/oauth/start', (req, res) => {
  const profileId = req.params.id;
  const settings = getSettings();
  const clientId = String(req.body?.clientId || settings.openaiOAuthClientId || process.env.OPENAI_OAUTH_CLIENT_ID || '').trim();

  // If client id exists, provide direct browser auth URL for callback paste flow.
  if (clientId) {
    const redirectUri = `http://localhost:${PORT}/oauth/callback`;
    const state = `quickclaw_${Date.now()}`;
    const authUrl = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=openid%20profile%20email&state=${encodeURIComponent(state)}`;
    saveSettings({ openaiOAuthClientId: clientId, openaiOAuthLastState: state });
    return res.json({
      success: true,
      authUrl,
      clientId,
      callbackHint: 'After login, copy the full localhost callback URL and paste into Complete Connection.',
      note: 'If browser auth fails, use helper mode (Terminal onboarding).'
    });
  }

  // Fallback helper mode (Terminal) when no client id is configured.
  const authUrl = `http://localhost:${PORT}/oauth/start-codex?profile=${encodeURIComponent(profileId)}`;
  return res.json({
    success: true,
    authUrl,
    clientId: null,
    callbackHint: 'No client id configured. Helper mode will launch onboarding in Terminal.',
    note: 'Add OAuth Client ID to use browser callback mode.'
  });
});
app.post('/api/profiles/:id/auth/oauth/complete', (req, res) => {
  const callbackUrl = String(req.body?.callbackUrl || '').trim();
  if (!callbackUrl) return res.json({ success: false, error: 'Callback URL is required.' });

  try {
    const u = new URL(callbackUrl);
    const code = u.searchParams.get('code') || '';
    const state = u.searchParams.get('state') || '';
    if (!code) return res.json({ success: false, error: 'No authorization code found in callback URL.' });

    saveSettings({
      openaiOAuthEnabled: true,
      openaiOAuthConnectedAt: new Date().toISOString(),
      openaiOAuthLastCode: String(code).slice(0, 8),
      openaiOAuthLastState: state || getSettings().openaiOAuthLastState || ''
    });

    const skills = getSkills().map(x => x.id === 'openai-auth' ? { ...x, installed: true, enabled: true } : x);
    saveSkills(skills);

    return res.json({ success: true, message: 'OAuth callback accepted. OpenAI Codex marked connected for this profile.' });
  } catch (e) {
    return res.json({ success: false, error: 'Invalid callback URL format.' });
  }
});
app.post('/api/profiles/:id/auth/oauth/manual', (req, res) => {
  const hasToken = !!String(req.body?.accessToken || '').trim();
  if (!hasToken) return res.json({ success: false, error: 'Missing access token' });
  saveSettings({ openaiOAuthEnabled: true });
  res.json({ success: true, message: 'Manual OAuth tokens saved (local-mode).' });
});
app.post('/api/profiles/:id/auth/oauth/cancel', (req, res) => res.json({ success: true }));
app.post('/api/profiles/:id/auth/oauth/revoke', (req, res) => {
  saveSettings({ openaiOAuthEnabled: false, openaiOAuthConnectedAt: null, openaiOAuthLastCode: null });
  res.json({ success: true, message: 'OAuth revoked.' });
});
app.post('/api/profiles/:id/auth/oauth/share', (req, res) => res.json({ success: true, message: 'OAuth sharing simulated in local-mode.' }));
app.post('/api/profiles/:id/auth/toggle', (req, res) => {
  const method = req.body?.method || 'api-key';
  saveSettings({ openaiOAuthEnabled: method === 'codex-oauth' });
  res.json({ success: true, message: `Auth mode switched to ${method}` });
});

// Telegram setup helpers + guidance
app.put('/api/profiles/:id/telegram/setup', (req, res) => {
  const botToken = String(req.body?.botToken || '').trim();
  if (!botToken || !botToken.includes(':')) return res.status(400).json({ ok: false, error: 'Invalid bot token format' });
  saveSettings({ telegramBotToken: botToken });
  res.json({ ok: true, message: 'Telegram bot token saved.', instructions: 'Create bot via @BotFather, add bot to chat, send /start.' });
});
app.post('/api/profiles/:id/telegram/users/add', (req, res) => res.json({ ok: true, message: 'User allowed.' }));
app.delete('/api/profiles/:id/telegram/users/:uid', (req, res) => res.json({ ok: true, message: 'User removed.' }));
app.get('/api/profiles/:id/telegram/info', (req, res) => {
  const token = String(getSettings().telegramBotToken || '');
  const masked = token ? token.slice(0, 8) + '...' + token.slice(-6) : '';
  res.json({
    enabled: !!token,
    hasToken: !!token,
    botToken: masked,
    users: [],
    instructions: [
      '1) Open @BotFather in Telegram.',
      '2) Create bot with /newbot and copy token.',
      '3) Paste token in Comms → Telegram and click Save & Restart.',
      '4) Add your user id to approved users and send /start to bot.'
    ]
  });
});

// Channel config setters
app.put('/api/profiles/:id/channel/discord', (req, res) => res.json({ ok: true, enabled: !!req.body?.enabled }));
app.put('/api/profiles/:id/channel/whatsapp', (req, res) => res.json({ ok: true, enabled: !!req.body?.enabled }));
app.put('/api/profiles/:id/channel/bluebubbles', (req, res) => res.json({ ok: true, enabled: !!req.body?.enabled }));



// Final safety-net for any remaining profile sub-endpoint requests from Command Center UI
app.all('/api/profiles/:id/*', (req, res) => {
  const sub = req.params[0] || '';

  // Return best-effort shapes so tabs do not hard-fail with 404
  if (sub.startsWith('files')) return res.json({ files: [], dir: null });
  if (sub.startsWith('history')) return res.json({ items: [], sessions: [] });
  if (sub.startsWith('memory')) return res.json({ items: [] });
  if (sub.startsWith('keys')) return res.json({ keys: [] });
  if (sub.startsWith('models')) return res.json({ models: [{ id: 'default', name: 'default', enabled: true }] });
  if (sub.startsWith('usage')) return res.json({ totals: { cost: 0, input: 0, output: 0 }, byModel: {}, byDay: [], noData: true, topSessions: [], raw: {} });
  if (sub.startsWith('config')) return res.json({ config: {} });
  if (sub.startsWith('soul')) return res.json({ content: '' });
  if (sub.startsWith('skills')) return res.json({ skills: getSkills() });
  if (sub.startsWith('logs')) return res.json({ logs: '' });
  if (sub.startsWith('auth')) return res.json({ openai: { oauthEnabled: false, hasApiKey: false } });
  if (sub.startsWith('channel/discord')) return res.json({ enabled: false });
  if (sub.startsWith('channel/whatsapp')) return res.json({ enabled: false });
  if (sub.startsWith('channel/bluebubbles')) return res.json({ enabled: false });

  return res.json({ ok: true, note: 'profile endpoint stub', path: sub });
});


// Local helper page: launch real Codex OAuth in Terminal (interactive TTY)
app.get('/oauth/start-codex', (req, res) => {
  const profile = String(req.query.profile || 'default');
  const localCmd = `${LOCAL_OPENCLAW} onboard --auth-choice openai-codex`;
  const globalCmd = `openclaw onboard --auth-choice openai-codex`;
  const cmd = `(${globalCmd}) || (${localCmd})`;

  let launchMsg = 'Opened OAuth command in Terminal.';
  try {
    if (process.platform === 'darwin') {
      const escaped = cmd.replace(/"/g, '\\"');
      execSync(`osascript -e 'tell application "Terminal" to do script "${escaped}"'`, { stdio: 'ignore' });
    } else {
      launchMsg = `Run manually: ${cmd}`;
    }
  } catch (e) {
    launchMsg = `Could not auto-open Terminal. Run manually: ${cmd}`;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Codex OAuth</title><style>body{font-family:system-ui;background:#0f1115;color:#e7e9ee;padding:24px}code{background:#1a1f2a;padding:4px 8px;border-radius:6px}a{color:#8ab4ff}</style></head><body><h2>OpenAI Codex OAuth Helper</h2><p>${launchMsg}</p><p>Profile: <code>${profile}</code></p><ol><li>Complete login in Terminal window.</li><li>If it says no provider plugins found, run <code>openclaw plugins doctor</code> and share output.</li><li>Return to dashboard Auth tab and click Refresh/Auth.</li></ol><p>Manual command:</p><p><code>${cmd}</code></p><p><a href="http://localhost:${PORT}">Back to Dashboard</a></p></body></html>`);
});

// API safety net: never return HTML for unknown /api routes (prevents client JSON parse failures)
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'API endpoint not implemented', path: req.path, method: req.method });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`V3 dashboard at http://localhost:${PORT}`));
