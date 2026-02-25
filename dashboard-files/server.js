const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const ROOT = process.env.QUICKCLAW_ROOT || path.resolve(__dirname, '..');
const PID_DIR = path.join(ROOT, '.pids');
const LOG_DIR = path.join(ROOT, 'logs');
const INSTALL_DIR = path.join(ROOT, 'openclaw');
const CONFIG_PATH = path.join(INSTALL_DIR, 'config', 'default.yaml');

for (const d of [PID_DIR, LOG_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function readPid(name) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(PID_DIR, `${name}.pid`), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function portListening(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti tcp:${port}`, (err, out) => resolve(!err && !!String(out).trim()));
  });
}

function tailFile(logFile, lines = 120) {
  const p = path.join(LOG_DIR, logFile);
  if (!fs.existsSync(p)) return '';
  const txt = fs.readFileSync(p, 'utf8');
  const arr = txt.split('\n');
  return arr.slice(-Math.max(lines, 1)).join('\n');
}

function gatewayCommand() {
  const b = path.join(INSTALL_DIR, 'node_modules', '.bin', 'openclaw');
  if (fs.existsSync(b)) return `"${b}" gateway start --allow-unconfigured`;
  return 'npx openclaw gateway start --allow-unconfigured';
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
  const gwPid = readPid('gateway');
  const dbPid = readPid('dashboard') || process.pid;
  res.json({
    gateway: { running: !!gwPid, pid: gwPid, port5000: await portListening(5000) },
    dashboard: { running: true, pid: dbPid, port: Number(PORT), port3000: await portListening(3000), port3001: await portListening(3001) },
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

app.post('/api/gateway/start', (req, res) => {
  const cur = readPid('gateway');
  if (cur) return res.json({ ok: true, message: 'already running', pid: cur });

  const cmd = gatewayCommand();
  const child = exec(`${cmd} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  fs.writeFileSync(path.join(PID_DIR, 'gateway.pid'), String(child.pid));
  child.unref();
  res.json({ ok: true, message: 'gateway start requested', pid: child.pid, cmd });
});

app.post('/api/gateway/stop', (req, res) => {
  const pid = readPid('gateway');
  if (!pid) return res.json({ ok: false, message: 'not running' });
  try { process.kill(pid, 'SIGTERM'); } catch {}
  try { fs.unlinkSync(path.join(PID_DIR, 'gateway.pid')); } catch {}
  res.json({ ok: true, message: 'gateway stop requested', pid });
});

app.post('/api/gateway/restart', async (req, res) => {
  const pid = readPid('gateway');
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    try { fs.unlinkSync(path.join(PID_DIR, 'gateway.pid')); } catch {}
  }
  const cmd = gatewayCommand();
  const child = exec(`${cmd} >> "${path.join(LOG_DIR, 'gateway.log')}" 2>&1`, { cwd: INSTALL_DIR });
  fs.writeFileSync(path.join(PID_DIR, 'gateway.pid'), String(child.pid));
  child.unref();
  res.json({ ok: true, message: 'gateway restart requested', pid: child.pid, cmd });
});

app.get('/api/config', (req, res) => {
  const exists = fs.existsSync(CONFIG_PATH);
  const content = exists ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  res.json({ exists, path: CONFIG_PATH, content });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`V3 dashboard at http://localhost:${PORT}`));
