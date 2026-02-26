/**
 * OpenClaw Command Center — QuickClaw Backend Server v2.5 (Modular)
 * 
 * Architecture:
 *   lib/helpers.js  — Shared utilities, constants, shell helpers
 *   lib/state.js    — Stateful data: profiles, settings, usage, news, versions
 *   routes/*.js     — Express route modules
 */
const express = require('express');
const http = require('http');
const path = require('path');
const h = require('./lib/helpers');
const st = require('./lib/state');

const app = express();
const server = http.createServer(app);

// Middleware
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// Mount route modules
app.use(require('./routes/system'));
app.use(require('./routes/profiles'));
app.use(require('./routes/channels'));
app.use(require('./routes/comms'));
app.use(require('./routes/security'));
app.use(require('./routes/files'));
app.use(require('./routes/news'));
app.use(require('./routes/versions'));
app.use(require('./routes/auth'));
app.use(require('./routes/extras'));

// Profile catch-all (safety net for unmatched profile sub-routes)
app.post('/api/profiles/:id/:action', (req, res) => res.json({ ok: true, action: req.params.action, id: req.params.id }));
app.all('/api/profiles/:id/*', (req, res) => {
  const sub = req.params[0] || '';
  if (sub.startsWith('files')) return res.json({ files: [], dir: null });
  if (sub.startsWith('history')) return res.json({ items: [], sessions: [] });
  if (sub.startsWith('memory')) return res.json({ items: [] });
  if (sub.startsWith('usage')) return res.json({ totals: { cost: 0, input: 0, output: 0 }, byModel: {}, byDay: [], noData: true });
  if (sub.startsWith('config')) return res.json({ config: {} });
  if (sub.startsWith('soul')) return res.json({ content: '' });
  if (sub.startsWith('skills')) return res.json({ skills: st.getSkills() });
  if (sub.startsWith('logs')) return res.json({ logs: '' });
  if (sub.startsWith('auth')) return res.json({ openai: { oauthEnabled: false, hasApiKey: false } });
  if (sub.startsWith('channel')) return res.json({ enabled: false });
  return res.json({ ok: true, note: 'profile endpoint stub', path: sub });
});

// API safety net
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'API endpoint not implemented', path: req.path, method: req.method }));

// SPA catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(h.PORT, () => console.log(`\n⚡ OpenClaw Command Center v2.5 (QuickClaw) | Port ${h.PORT}\nDashboard: http://localhost:${h.PORT}\n`));
