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

for (const d of [PID_DIR, LOG_DIR, DATA_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

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
  const starter = [{ id: 'default', name: 'Default', active: true, createdAt: new Date().toISOString() }];
  writeJson(PROFILES_PATH, starter);
  return starter;
}
function saveProfiles(list) { writeJson(PROFILES_PATH, list); }
function getSettings() {
  return readJson(SETTINGS_PATH, {
    openaiApiKey: '', anthropicApiKey: '', telegramBotToken: '', ftpHost: '', ftpUser: '', emailUser: ''
  });
}
function saveSettings(s) { writeJson(SETTINGS_PATH, { ...getSettings(), ...s }); }

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

function applySettingsToConfigFile() {
  const s = getSettings();
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
  return CONFIG_PATH;
}

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
  const file = applySettingsToConfigFile();
  res.json({ ok: true, message: 'Config regenerated from dashboard settings', path: file });
});

app.get('/api/profiles', (req, res) => res.json({ profiles: getProfiles() }));
app.post('/api/profiles', (req, res) => {
  const list = getProfiles();
  const id = `p-${Date.now()}`;
  list.push({ id, name: req.body?.name || `Profile ${list.length + 1}`, active: false, createdAt: new Date().toISOString() });
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});
app.post('/api/profiles/activate', (req, res) => {
  const id = req.body?.id;
  const list = getProfiles().map(p => ({ ...p, active: p.id === id }));
  saveProfiles(list);
  res.json({ ok: true, profiles: list });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => { saveSettings(req.body || {}); res.json({ ok: true, settings: getSettings() }); });
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`V3 dashboard at http://localhost:${PORT}`));
