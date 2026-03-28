/**
 * db.js — Pure JS file-based storage
 *
 * 优化：quota 使用内存 Map 做一级缓存（写穿式），避免每次请求做两次同步磁盘 IO
 * 每 30s 或写入时主动落盘，进程退出时也保证落盘
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, promises as fs } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(__dir, '../data');
mkdirSync(DATA_DIR, { recursive: true });

// ─── 通用 JSON 读写 ────────────────────────────────────────────────────────
function loadJSON(file, def) {
  const p = join(DATA_DIR, file);
  if (!existsSync(p)) return def;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return def; }
}
function saveJSON(file, data) {
  writeFileSync(join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ─── 用户管理 ──────────────────────────────────────────────────────────────
export function getUsers() { return loadJSON('users.json', []); }
export function saveUsers(users) { saveJSON('users.json', users); }

export function getUserByKey(apiKey) {
  return getUsers().find(u => u.api_key === apiKey && u.active);
}

export function createUser({
  username,
  quota_per_window = 120,
  window_seconds = 18000,
  provider = 'optimal_sf',
}) {
  const users = getUsers();
  if (users.find(u => u.username === username)) throw new Error('Username exists');
  const user = {
    id: Date.now(),
    username,
    api_key: `cp-${randomHex(32)}`,
    quota_per_window,
    window_seconds,
    provider,
    active: true,
    created_at: new Date().toISOString(),
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

// ─── ★ Quota 内存缓存（写穿） ──────────────────────────────────────────────
// 结构：Map<userId, number[]> — 存 Unix 时间戳（秒）
let _quotaCache = null;          // null 表示尚未加载
let _quotaDirty = false;         // 是否有未落盘的修改

function getQuotaCache() {
  if (_quotaCache !== null) return _quotaCache;
  // 首次加载从磁盘读
  const raw = loadJSON('quota_events.json', {});
  _quotaCache = new Map(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : []]));
  return _quotaCache;
}

function flushQuota() {
  if (!_quotaDirty || _quotaCache === null) return;
  try {
    const obj = {};
    for (const [k, v] of _quotaCache) obj[k] = v;
    saveJSON('quota_events.json', obj);
    _quotaDirty = false;
  } catch (e) {
    console.error('[quota] flush failed:', e.message);
  }
}

// 定时落盘（每 30s）
setInterval(flushQuota, 30_000).unref();

// 进程退出时强制落盘
for (const sig of ['exit', 'SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(sig, () => { flushQuota(); if (sig !== 'exit') process.exit(); });
}

export function checkAndConsumeQuota(userId, maxCalls, windowSec, peekOnly = false) {
  const uid = String(userId);
  const now = Math.floor(Date.now() / 1000);
  const cache = getQuotaCache();

  // 清理过期
  const events = (cache.get(uid) || []).filter(ts => ts >= now - windowSec);
  const count = events.length;

  if (count >= maxCalls) {
    cache.set(uid, events);
    _quotaDirty = true;
    return { allowed: false, remaining: 0, resetAt: events[0] + windowSec };
  }

  if (!peekOnly) {
    events.push(now);
    _quotaDirty = true;
  }

  cache.set(uid, events);
  // 写穿：每次修改都落盘（保守策略，改为只靠定时落盘也可以）
  // 注意：这里保留写穿以避免进程崩溃丢数据
  flushQuota();

  return { allowed: true, remaining: maxCalls - events.length + (peekOnly ? 0 : 0), resetAt: null };
}

// ─── 使用记录 ──────────────────────────────────────────────────────────────
export function recordUsage(entry) {
  const log = loadJSON('usage_log.json', []);
  log.push({ ...entry, created_at: new Date().toISOString() });
  if (log.length > 10000) log.splice(0, log.length - 10000);
  saveJSON('usage_log.json', log);
}

export async function recordConversation(reqId, data) {
  const entry = { reqId, ...data, created_at: new Date().toISOString() };
  const line = JSON.stringify(entry) + '\n';
  const logFile = join(DATA_DIR, 'regression_log.jsonl');
  try {
    // ★ 按日期滚动：超过 50MB 时重命名
    try {
      const stat = await fs.stat(logFile);
      if (stat.size > 50 * 1024 * 1024) {
        const date = new Date().toISOString().slice(0, 10);
        await fs.rename(logFile, logFile.replace('.jsonl', `_${date}.jsonl`));
      }
    } catch (_) {}
    await fs.appendFile(logFile, line);
  } catch (err) {
    console.error('FAILED to record conversation:', err);
  }
}

// ─── 统计 ──────────────────────────────────────────────────────────────────
export function getStats(userId, days = 7) {
  const since = Date.now() - days * 86400000;
  const log = loadJSON('usage_log.json', []).filter(e =>
    new Date(e.created_at).getTime() >= since &&
    (userId ? String(e.user_id) === String(userId) : true)
  );
  const totals = {
    total_requests: log.length,
    total_input_tokens:  log.reduce((s, e) => s + (e.input_tokens  || 0), 0),
    total_output_tokens: log.reduce((s, e) => s + (e.output_tokens || 0), 0),
    avg_latency_ms: log.length
      ? log.reduce((s, e) => s + (e.latency_ms || 0), 0) / log.length
      : 0,
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

// ─── 工具 ──────────────────────────────────────────────────────────────────
function randomHex(n) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
