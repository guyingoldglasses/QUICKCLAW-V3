const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const ROOT = process.env.QUICKCLAW_ROOT || path.resolve(__dirname, '..');
const PID_DIR = path.join(ROOT, '.pids');
const LOG_DIR = path.join(ROOT, 'logs');
const INSTALL_DIR = path.join(ROOT, 'openclaw');
const CONFIG_PATH = path.join(INSTALL_DIR, 'config', 'default.yaml');
const LOCAL_OPENCLAW = path.join(INSTALL_DIR, 'node_modules', '.bin', 'openclaw');

for (const d of [PID_DIR, LOG_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function run(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, opts, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error ? String(error.message || error) : null });
    });
  });
}

function portListeningSync(port) {
  try {
    execSync(`lsof -ti tcp:${port}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function tailFile(logFile, lines = 120) {
  const p = path.join(LOG_DIR, logFile);
  if (!fs.existsSync(p)) return '';
  const txt = fs.readFileSync(p, 'utf8');
  const arr = txt.split('\n');
  return arr.slice(-Math.max(lines, 1)).join('\n');
}

function cliBin() {
  if (fs.existsSync(LOCAL_OPENCLAW)) return `"${LOCAL_OPENCLAW}"`;
  return 'npx openclaw';
}

function gatewayStartCommand() {
  return `${cliBin()} gateway start --allow-unconfigured`;
}

function gatewayStopCommand() {
  return `${cliBin()} gateway stop`;
}

async function gatewayState() {
  const ws18789 = portListeningSync(18789);
  const ws5000 = portListeningSync(5000);

  const status = await run(`${cliBin()} gateway status`, { cwd: INSTALL_DIR });
  const txt = `${status.stdout}\n${status.stderr}`;
  const looksRunning = /Runtime:\s*running|listening on ws:\/\/127\.0\.0\.1:18789|gateway\s+running/i.test(txt);

  return {
    running: ws18789 || ws5000 || looksRunning,
    ws18789,
    port5000: ws5000,
    statusText: txt.trim()
  };
}

function addonsStatus() {
  let cfg = '';
  try { cfg = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch {}
  const has = (k) => cfg.includes(`${k}:`);
  return {
    openai: has('openai') ? 'configured-section' : 'missing',
    anthropic: has('anthropic') ? 'configured-section' : 'missing',
    telegram: has('telegram') ? 'configured-section' : 'missing',
    ftp: has('ftp') ? 'configured-section' : 'missing',
    email: has('email') ? 'configured-section' : 'missing'
  };
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

app.get('/api/log/:name', (req, res) => {
  const name = req.params.name === 'gateway' ? 'gateway.log' : 'dashboard.log';
  const lines = parseInt(req.query.lines || '120', 10);
  res.type('text/plain').send(tailFile(name, lines));
});

app.post('/api/gateway/start', async (req, res) => {
  const cmd = gatewayStartCommand();
  const result = await run(`${cmd} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: gw.running, message: gw.running ? 'gateway running' : 'gateway start attempted', cmd, result, gateway: gw });
});

app.post('/api/gateway/stop', async (req, res) => {
  const cmd = gatewayStopCommand();
  const result = await run(`${cmd} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: !gw.running, message: !gw.running ? 'gateway stopped' : 'gateway stop attempted', cmd, result, gateway: gw });
});

app.post('/api/gateway/restart', async (req, res) => {
  await run(`${gatewayStopCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  await run(`${gatewayStartCommand()} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  const gw = await gatewayState();
  res.json({ ok: gw.running, message: gw.running ? 'gateway restarted' : 'gateway restart attempted', gateway: gw });
});

app.get('/api/config', (req, res) => {
  const exists = fs.existsSync(CONFIG_PATH);
  const content = exists ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  res.json({ exists, path: CONFIG_PATH, content });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`V3 dashboard at http://localhost:${PORT}`));
