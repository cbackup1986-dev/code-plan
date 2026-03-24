/**
 * Pure JS file-based storage — no native compilation needed
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(__dir, '../data');
mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(file, def) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return def;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

export function getUsers() { return loadJSON('users.json', []); }
export function saveUsers(users) { saveJSON('users.json', users); }
export function getUserByKey(apiKey) {
  return getUsers().find(u => u.api_key === apiKey && u.active);
}
export function createUser({ username, quota_per_window = 120, window_seconds = 18000, provider = 'optimal_sf' }) {
  const users = getUsers();
  if (users.find(u => u.username === username)) throw new Error('Username exists');
  const user = {
    id: Date.now(), username,
    api_key: `cp-${randomHex(32)}`,
    quota_per_window, window_seconds, provider,
    active: true, created_at: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}
export function updateUser(id, patch) {
  const users = getUsers();
  const idx = users.findIndex(u => u.id === parseInt(id));
  if (idx === -1) return null;
  Object.assign(users[idx], patch);
  saveUsers(users);
  return users[idx];
}

function loadQuota() { return loadJSON('quota_events.json', {}); }
function saveQuota(q) { saveJSON('quota_events.json', q); }

export function checkAndConsumeQuota(userId, maxCalls, windowSec, peekOnly = false) {
  const uid = String(userId);
  const quota = loadQuota();
  const now = Math.floor(Date.now() / 1000);
  quota[uid] = (quota[uid] || []).filter(ts => ts >= now - windowSec);
  const count = quota[uid].length;
  if (count >= maxCalls) {
    saveQuota(quota);
    return { allowed: false, remaining: 0, resetAt: quota[uid][0] + windowSec };
  }
  if (!peekOnly) { quota[uid].push(now); saveQuota(quota); }
  return { allowed: true, remaining: maxCalls - count - (peekOnly ? 0 : 1), resetAt: null };
}

export function recordUsage(entry) {
  const log = loadJSON('usage_log.json', []);
  log.push({ ...entry, created_at: new Date().toISOString() });
  if (log.length > 10000) log.splice(0, log.length - 10000);
  saveJSON('usage_log.json', log);
}

export function getStats(userId, days = 7) {
  const since = Date.now() - days * 86400000;
  const log = loadJSON('usage_log.json', []).filter(e =>
    new Date(e.created_at).getTime() >= since &&
    (userId ? String(e.user_id) === String(userId) : true)
  );
  const totals = {
    total_requests: log.length,
    total_input_tokens: log.reduce((s, e) => s + (e.input_tokens || 0), 0),
    total_output_tokens: log.reduce((s, e) => s + (e.output_tokens || 0), 0),
    avg_latency_ms: log.length ? log.reduce((s, e) => s + (e.latency_ms || 0), 0) / log.length : 0,
  };
  const byDay = {};
  for (const e of log) {
    const d = e.created_at.slice(0, 10);
    if (!byDay[d]) byDay[d] = { date: d, requests: 0, tokens: 0 };
    byDay[d].requests++;
    byDay[d].tokens += (e.input_tokens || 0) + (e.output_tokens || 0);
  }
  const byModel = {};
  for (const e of log) byModel[e.claude_model] = (byModel[e.claude_model] || 0) + 1;
  return {
    totals,
    daily: Object.values(byDay).sort((a, b) => b.date.localeCompare(a.date)),
    byModel: Object.entries(byModel).map(([claude_model, count]) => ({ claude_model, count })),
  };
}

function randomHex(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
