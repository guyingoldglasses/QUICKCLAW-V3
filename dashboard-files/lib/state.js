/**
 * state.js — Stateful data: profiles, settings, skills, usage, news, versions
 */
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

// ═══ PROFILE MANAGEMENT ═══
function getProfiles() {
  const list = h.readJson(h.PROFILES_PATH, null);
  if (Array.isArray(list) && list.length) return list;
  const starter = [{ id: 'default', name: 'Default', active: true, status: 'running', port: 3000, notes: '', soul: '', memoryPath: '', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }];
  h.writeJson(h.PROFILES_PATH, starter);
  return starter;
}
function saveProfiles(list) { h.writeJson(h.PROFILES_PATH, list); }

function profilePaths(profileId) {
  const ocDir = path.join(h.HOME, '.openclaw');
  const cbDir = path.join(h.HOME, '.clawdbot');
  if (profileId === 'default') {
    const configDir = fs.existsSync(ocDir) ? ocDir : (fs.existsSync(cbDir) ? cbDir : ocDir);
    const workspace = fs.existsSync(path.join(h.HOME, 'clawd')) ? path.join(h.HOME, 'clawd') : h.ROOT;
    return { configDir, workspace, envPath: path.join(configDir, '.env'), configJson: path.join(configDir, 'clawdbot.json') };
  }
  const suffix = '-' + profileId.replace(/^p-/, '');
  const configDir = fs.existsSync(ocDir + suffix) ? (ocDir + suffix) : (cbDir + suffix);
  const workspace = path.join(h.HOME, 'clawd' + suffix);
  return { configDir, workspace, envPath: path.join(configDir, '.env'), configJson: path.join(configDir, 'clawdbot.json') };
}

function profileEnvVars(profileId) {
  const pp = profilePaths(typeof profileId === 'object' ? (profileId.id || profileId) : profileId);
  return { CLAWDBOT_CONFIG_DIR: pp.configDir, OPENCLAW_CONFIG_DIR: pp.configDir };
}

function findSoul(pp) {
  const cfg = h.readJson(pp.configJson, null);
  const paths = [];
  if (cfg?.soulFile) paths.push(path.resolve(pp.workspace, cfg.soulFile));
  paths.push(path.join(pp.workspace, 'soul.md'), path.join(pp.workspace, 'SOUL.md'), path.join(pp.configDir, 'soul.md'));
  for (const x of paths) if (fs.existsSync(x)) return x;
  return null;
}
function getSkillStates(pp) { return h.readJson(path.join(pp.workspace, '.skill-states.json'), {}); }
function saveSkillStates(pp, s) { h.writeJson(path.join(pp.workspace, '.skill-states.json'), s); }

// ═══ SETTINGS ═══
function getSettings() {
  return h.readJson(h.SETTINGS_PATH, {
    openaiApiKey: '', openaiOAuthEnabled: false, anthropicApiKey: '',
    telegramBotToken: '', ftpHost: '', ftpUser: '', emailUser: ''
  });
}
function saveSettings(s) { h.writeJson(h.SETTINGS_PATH, { ...getSettings(), ...s }); }

// ═══ SKILLS CATALOG ═══
function defaultSkillsCatalog() {
  return [
    { id: 'core-tools', name: 'Core Platform Tools', description: 'Essential local runtime controls.', includes: ['gateway controls', 'log viewer', 'config apply/backup', 'profile persistence'], enabled: true, installed: true, risk: 'low' },
    { id: 'openai-auth', name: 'OpenAI Authentication', description: 'Stores OpenAI credentials and OAuth mode flags.', includes: ['api key field', 'oauth mode flag', 'settings export/import'], enabled: false, installed: true, risk: 'medium' },
    { id: 'ftp-deploy', name: 'FTP Deploy', description: 'Deployment helper settings for FTP workflows.', includes: ['ftp host/user settings', 'future deploy hooks'], enabled: false, installed: false, risk: 'medium' },
    { id: 'telegram-setup', name: 'Telegram Setup', description: 'Easy BotFather token setup and quick-connect.', includes: ['token save', 'config apply', 'connection hints'], enabled: false, installed: false, risk: 'low' },
    { id: 'email', name: 'Email Integration', description: 'Email account settings for notifications.', includes: ['email user settings', 'future send/read actions'], enabled: false, installed: false, risk: 'medium' },
    { id: 'antfarm', name: 'Antfarm Automation', description: 'Task queue + run history panel.', includes: ['run queue', 'recent runs', 'status panel'], enabled: false, installed: false, risk: 'medium' },
  ];
}
function getSkills() {
  const list = h.readJson(h.SKILLS_PATH, null);
  const defaults = defaultSkillsCatalog();
  if (Array.isArray(list)) {
    const byId = Object.fromEntries(defaults.map(s => [s.id, s]));
    const merged = list.map(s => ({ ...byId[s.id], ...s }));
    for (const d of defaults) if (!merged.find(x => x.id === d.id)) merged.push(d);
    return merged;
  }
  h.writeJson(h.SKILLS_PATH, defaults);
  return defaults;
}
function saveSkills(list) { h.writeJson(h.SKILLS_PATH, list); }

function getAntfarmRuns() { return h.readJson(h.ANTFARM_RUNS_PATH, []); }
function saveAntfarmRuns(runs) { h.writeJson(h.ANTFARM_RUNS_PATH, runs); }
function getChatHistory() { return h.readJson(h.CHAT_HISTORY_PATH, []); }
function saveChatHistory(rows) { h.writeJson(h.CHAT_HISTORY_PATH, rows); }

// ═══ PROFILE ENV STORE ═══
function getProfileEnvStore() { return h.readJson(h.PROFILE_ENV_PATH, {}); }
function saveProfileEnvStore(store) { h.writeJson(h.PROFILE_ENV_PATH, store); }
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

// ═══ USAGE TRACKING ═══
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
    if (fs.existsSync(memDir)) fs.readdirSync(memDir).forEach(f => {
      if (f.match(/^usage[-_]?\d{4}/) && f.endsWith('.json')) locations.push(path.join(memDir, f));
    });
  } catch {}
  return locations.filter(l => fs.existsSync(l));
}

function aggregateUsage(pp) {
  const files = findUsageLogs(pp);
  let tIn = 0, tOut = 0, tCost = 0;
  const byModel = {}, byDay = {}, sessions = [];
  let lastModified = null;

  files.forEach(fp => {
    const data = h.readJson(fp, null); if (!data) return;
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

// ═══ NEWS ═══
function loadNews() { return h.readJson(h.NEWS_FILE, { articles: [], lastFetched: null }); }
function saveNews(data) { h.writeJson(h.NEWS_FILE, data); }
function loadNewsPrefs() {
  return h.readJson(h.NEWS_PREFS_FILE, {
    quality: [], useless: [], bookmarks: [], deletedUrls: [],
    sources: { hn_ai: true, hn_openclaw: true, hn_agents: true, hn_llm: true, github: true, reddit_ai: true, arxiv: true, techcrunch: true },
    customSources: {}
  });
}
function saveNewsPrefs(p) { h.writeJson(h.NEWS_PREFS_FILE, p); }

// ═══ VERSIONS ═══
function getVersions() {
  const meta = h.readJson(path.join(h.VERSIONS_DIR, 'versions.json'), null);
  return meta || { versions: [], current: null, baseStable: null };
}
function saveVersionsMeta(data) { h.writeJson(path.join(h.VERSIONS_DIR, 'versions.json'), data); }

// ═══ CONFIG FILE HELPERS ═══
function openclawConfigPath() { return path.join(h.HOME, '.openclaw', 'openclaw.json'); }
function writeOpenclawTelegramToken(token) {
  const p = openclawConfigPath();
  if (!fs.existsSync(p)) return { ok: false, error: `Config not found: ${p}` };
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.channels = cfg.channels || {}; cfg.channels.telegram = cfg.channels.telegram || {};
  cfg.channels.telegram.botToken = token;
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return { ok: true, path: p };
}
function backupCurrentConfig() {
  if (!fs.existsSync(h.CONFIG_PATH)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(h.CONFIG_BACKUPS_DIR, `default-${stamp}.yaml`);
  fs.copyFileSync(h.CONFIG_PATH, dst); return dst;
}
function applySettingsToConfigFile() {
  const s = getSettings(); const backup = backupCurrentConfig();
  const lines = ['# QuickClaw V3 generated config', 'gateway:', '  mode: local', '  port: 5000', '  host: 127.0.0.1', ''];
  if (s.openaiApiKey) lines.push('openai:', `  api_key: "${s.openaiApiKey}"`, '');
  if (s.anthropicApiKey) lines.push('anthropic:', `  api_key: "${s.anthropicApiKey}"`, '');
  if (s.telegramBotToken) lines.push('telegram:', `  bot_token: "${s.telegramBotToken}"`, '');
  if (s.ftpHost || s.ftpUser) lines.push('ftp:', ...(s.ftpHost ? [`  host: "${s.ftpHost}"`] : []), ...(s.ftpUser ? [`  user: "${s.ftpUser}"`] : []), '');
  if (s.emailUser) lines.push('email:', `  user: "${s.emailUser}"`, '');
  fs.mkdirSync(path.dirname(h.CONFIG_PATH), { recursive: true });
  fs.writeFileSync(h.CONFIG_PATH, lines.join('\n'));
  return { path: h.CONFIG_PATH, backup };
}

module.exports = {
  getProfiles, saveProfiles, profilePaths, profileEnvVars, findSoul,
  getSkillStates, saveSkillStates, getSettings, saveSettings,
  getSkills, saveSkills, getAntfarmRuns, saveAntfarmRuns,
  getChatHistory, saveChatHistory,
  getProfileEnvStore, saveProfileEnvStore, getProfileEnv,
  aggregateUsage, loadNews, saveNews, loadNewsPrefs, saveNewsPrefs,
  getVersions, saveVersionsMeta,
  openclawConfigPath, writeOpenclawTelegramToken, backupCurrentConfig, applySettingsToConfigFile
};
