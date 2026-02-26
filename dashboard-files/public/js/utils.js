/* ============================================
   QuickClaw Dashboard — Utilities Module
   Shared helpers: API, formatting, class names
   ============================================ */

const {useState, useEffect, useCallback, useRef} = React;
const TOKEN = new URLSearchParams(window.location.search).get('token') || '';

async function api(ep, opts = {}) {
  const sep = ep.includes('?') ? '&' : '?';
  const cfg = {headers: {'Content-Type': 'application/json'}, ...opts};
  if (opts.body && typeof opts.body === 'object') cfg.body = JSON.stringify(opts.body);
  const res = await fetch('/api' + ep + sep + 'token=' + TOKEN, cfg);
  if (res.status === 401) throw new Error('Unauthorized');
  return res.json();
}

function dlUrl(ep) {
  return '/api' + ep + (ep.includes('?') ? '&' : '?') + 'token=' + TOKEN;
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  if (!n) return '$0.00';
  return '$' + n.toFixed(4);
}

function cn() {
  var r = '';
  for (var i = 0; i < arguments.length; i++)
    if (arguments[i]) r += (r ? ' ' : '') + arguments[i];
  return r;
}

function Toast({message, type}) {
  if (!message) return null;
  var c = type === 'error' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--accent)';
  return React.createElement('div', {className: 'toast'},
    React.createElement('span', {style: {color: c}}, '●'), message);
}
