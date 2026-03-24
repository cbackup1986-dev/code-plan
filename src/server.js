/**
 * Code Plan Proxy — 完整优化版
 *
 * 新增:
 * 1. 请求超时保护（AbortController）
 * 2. 自动重试（后端 5xx / 429 最多重试 2 次，指数退避）
 * 3. ThinkingFilter 流式过滤 <think> 块（R1 模型）
 * 4. 结构化请求日志（方便调试 Agent 循环断点）
 * 5. 观察后推理注入（converter 层已实现，server 透传 provider）
 */
import express from 'express';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  getUserByKey, getUsers, createUser, updateUser,
  checkAndConsumeQuota, recordUsage, getStats,
} from './db.js';
import {
  convertRequest, convertResponse,
  mapStopReason, ToolCallAccumulator, ThinkingFilter, repairJSON,
} from './converter.js';
import { getProvider } from './providers.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, x-api-key, Authorization, anthropic-version, anthropic-beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── 结构化日志 ────────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug | info | warn | error

function log(level, reqId, msg, data = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] < levels[LOG_LEVEL]) return;
  const line = { ts: new Date().toISOString(), level, reqId, msg, ...data };
  const str = JSON.stringify(line);
  console.log(str);
  try {
    appendFileSync('e:/ai/code-plan-proxy/code-plan/proxy-debug.log', str + '\n');
  } catch(e){}
}

// ─── Auth ──────────────────────────────────────────────────────────────────
function authenticate(req, res, next) {
  console.log('DEBUG: Auth Attempt Headers:', JSON.stringify(req.headers));
  const key = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!key) {
    log('warn', '-', 'auth_failed', { reason: 'Missing API key', ip: req.ip, path: req.path });
    return res.status(401).json(anthropicError('authentication_error', 'Missing API key'));
  }
  const user = getUserByKey(key);
  if (!user) {
    log('warn', '-', 'auth_failed', { reason: 'Invalid API key', key: key.slice(0, 8) + '...', ip: req.ip, path: req.path });
    return res.status(401).json(anthropicError('authentication_error', 'Invalid API key'));
  }
  if (!user.active) {
    log('warn', '-', 'auth_failed', { reason: 'User disabled', user: user.username, ip: req.ip });
    return res.status(401).json(anthropicError('authentication_error', 'User account is disabled'));
  }
  req.user = user;
  next();
}

function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

// ─── 带超时和重试的 fetch ★ ────────────────────────────────────────────────
async function fetchWithRetry(url, options, timeoutMs, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);

      // 不重试流式请求的错误（响应体已开始消费）
      if (res.ok) return res;

      // 429 / 5xx 重试
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const wait = (attempt + 1) * 1500; // 1.5s, 3s
        lastErr = new Error(`Backend ${res.status}`);
        await sleep(wait);
        continue;
      }

      return res; // 4xx 等不重试，直接返回
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      lastErr = err;
      if (attempt < maxRetries) {
        await sleep((attempt + 1) * 1500);
      }
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── /v1/messages ──────────────────────────────────────────────────────────
app.post(['/v1/messages', '/messages'], authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body;
  const requestId = randomUUID();
  const isStream = body.stream === true;
  const originalModel = body.model || 'claude-sonnet-4-20250514';

  // 配额检查
  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds);
  if (!quota.allowed) {
    const resetISO = new Date(quota.resetAt * 1000).toISOString();
    return res.status(429).json(anthropicError('rate_limit_error',
      `配额已用尽，将于 ${resetISO} 重置 (${user.quota_per_window}次/${Math.round(user.window_seconds/3600)}h)`
    ));
  }

  const provider = getProvider(user.provider || 'nvidia');
  const converted = convertRequest(body, provider);
  const startTime = Date.now();

  log('info', requestId, 'request', {
    user: user.username,
    model: originalModel,
    backend: converted.model,
    provider: user.provider,
    stream: isStream,
    messages: body.messages?.length,
    hasTools: !!body.tools?.length,
  });

  try {
    writeFileSync('e:/ai/code-plan-proxy/code-plan/last_request.json', JSON.stringify(converted, null, 2));
  } catch(e) {}

  let backendRes;
  try {
    backendRes = await fetchWithRetry(
      provider.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(converted),
      },
      provider.timeoutMs || 120000,
    );
  } catch (err) {
    log('error', requestId, 'fetch_failed', { error: err.message });
    return res.status(502).json(anthropicError('api_error', err.message));
  }

  if (!backendRes.ok) {
    const txt = await backendRes.text().catch(() => '');
    log('error', requestId, 'backend_error', { status: backendRes.status, body: txt.slice(0, 300) });
    return res.status(502).json(anthropicError('api_error', `Backend error ${backendRes.status}`));
  }

  const durationToHeaders = Date.now() - startTime;
  log('info', requestId, 'backend_headers_received', { latency_ms: durationToHeaders, status: backendRes.status });

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Quota-Remaining', String(quota.remaining));

    const usage = await handleStream(backendRes.body, res, originalModel, requestId, provider, startTime);

    log('info', requestId, 'stream_done', {
      latency_ms: Date.now() - startTime,
      input_tokens: usage.input, output_tokens: usage.output,
      thinking_tokens: usage.thinking,
    });

    recordUsage({
      user_id: user.id, request_id: requestId,
      claude_model: originalModel, backend_model: converted.model,
      input_tokens: usage.input, output_tokens: usage.output,
      latency_ms: Date.now() - startTime,
    });
  } else {
    const data = await backendRes.json();
    const response = convertResponse(data, originalModel, requestId, provider);

    log('info', requestId, 'response', {
      latency_ms: Date.now() - startTime,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });

    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Quota-Remaining', String(quota.remaining));
    res.json(response);

    recordUsage({
      user_id: user.id, request_id: requestId,
      claude_model: originalModel, backend_model: converted.model,
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      latency_ms: Date.now() - startTime,
    });
  }
});

// ─── 流式处理 ★ ─────────────────────────────────────────────────────────────
async function handleStream(stream, res, originalModel, requestId, provider, startTime) {
  const msgId = `msg_${requestId.replace(/-/g, '').slice(0, 24)}`;
  let inputTokens = 0, outputTokens = 0;

  const send = (event, data) => {
    console.log(`DEBUG [${requestId}] send event: ${event}`, JSON.stringify(data).slice(0, 150));
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  send('message_start', {
    type: 'message_start',
    message: {
      id: msgId, type: 'message', role: 'assistant',
      model: originalModel, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  send('ping', { type: 'ping' });

  let textBlockOpen = false;
  let reasoningBlockOpen = false;
  const toolAcc = new ToolCallAccumulator();
  const suppressedIndices = new Set();
  let hasToolCalls = false;
  let finishReason = null;
  let usageFromChunk = null;

  // ★ 思维链过滤器（R1 模型专用）
  const thinkFilter = provider.stripThinking ? new ThinkingFilter() : null;

  let buffer = '';
  let thinkingContent = '';

  let chunkCount = 0;
  const pingInterval = setInterval(() => {
    if (chunkCount === 0) {
      send('ping', { type: 'ping' });
    }
  }, 15000); // Send ping every 15s until data arrives
  
  // Track tool block mapping: OpenAI index -> Anthropic block index
  let currentBlockIndex = 0;
  const validToolBlockIndices = new Map();

  try {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      chunkCount++;
      if (chunkCount === 1) {
        clearInterval(pingInterval);
        log('info', requestId, 'first_chunk_received', { latency_ms: Date.now() - startTime });
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') continue;

        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }

        const delta = data.choices?.[0]?.delta;
        const chunkFinish = data.choices?.[0]?.finish_reason;
        if (chunkFinish) finishReason = chunkFinish;
        if (data.usage) usageFromChunk = data.usage;
        if (!delta) continue;

        // 文本 delta —— 经过 thinking filter
        if (delta.content) {
          console.log(`DEBUG [${requestId}] content:`, delta.content);
          const text = thinkFilter ? thinkFilter.feed(delta.content) : delta.content;
          if (text) {
            // 如果还在推理中，先关掉推理块
            if (reasoningBlockOpen) {
              send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
              reasoningBlockOpen = false;
              currentBlockIndex++;
            }
            if (!textBlockOpen) {
              send('content_block_start', {
                type: 'content_block_start', index: currentBlockIndex,
                content_block: { type: 'text', text: '' },
              });
              textBlockOpen = true;
            }
            send('content_block_delta', {
              type: 'content_block_delta', index: currentBlockIndex,
              delta: { type: 'text_delta', text },
            });
            outputTokens++;
          }
        }

        // 推理 delta (SiliconFlow/Kimi)
        if (delta.reasoning_content) {
          console.log(`DEBUG [${requestId}] reasoning:`, delta.reasoning_content);
          if (!reasoningBlockOpen) {
            // 如果还在发文本，关掉它（理论上推理应在文本之前）
            if (textBlockOpen) {
              send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
              textBlockOpen = false;
              currentBlockIndex++;
            }
            send('content_block_start', {
              type: 'content_block_start', index: currentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            });
            reasoningBlockOpen = true;
          }
          send('content_block_delta', {
            type: 'content_block_delta', index: currentBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          });
          thinkingContent += delta.reasoning_content;
        }

        // Tool call
        if (delta.tool_calls?.length) {
          // console.log('DEBUG: Received Tool Call from Backend:', JSON.stringify(delta.tool_calls));
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (tc.function?.name === 'think') {
              suppressedIndices.add(idx);
              continue;
            }
            if (suppressedIndices.has(idx)) continue;

            hasToolCalls = true;

            if (tc.id) {
              if (reasoningBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
                reasoningBlockOpen = false;
                currentBlockIndex++;
              }
              if (textBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
                textBlockOpen = false;
                currentBlockIndex++;
              }

              // Since OpenAI can stream parallel tools, we just allocate a new block index for each new tool id.
              const blockIdx = currentBlockIndex++;
              validToolBlockIndices.set(idx, blockIdx);

              send('content_block_start', {
                type: 'content_block_start', index: blockIdx,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function?.name || '',
                },
              });
            }

            const blockIdx = validToolBlockIndices.get(idx);
            if (blockIdx !== undefined && tc.function?.arguments) {
              send('content_block_delta', {
                type: 'content_block_delta', index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              });
            }
          }
          toolAcc.feed(delta.tool_calls);
        }
      }
    }
  } catch (err) {
    log('error', requestId, 'stream_error', { error: err.message });
  } finally {
    clearInterval(pingInterval);
  }

  // 关闭文本块或所有的工具块
  if (reasoningBlockOpen) {
    send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
  }

  if (textBlockOpen) {
    send('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
  } 
  
  if (validToolBlockIndices.size > 0) {
    for (const blockIdx of validToolBlockIndices.values()) {
      send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
    }
  } 
  
  if (currentBlockIndex === 0 && !textBlockOpen && validToolBlockIndices.size === 0) {
    // 啥都没有，发个空的
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
  }

  const stopReason = mapStopReason(finishReason, hasToolCalls);
  const finalOutput = usageFromChunk?.completion_tokens || outputTokens;
  inputTokens = usageFromChunk?.prompt_tokens || 0;
  
  const thinkingTokens = thinkFilter
    ? Math.ceil(thinkFilter.getThinking().length / 4)
    : Math.ceil(thinkingContent.length / 4);

  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: finalOutput },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();

  return { input: inputTokens, output: finalOutput, thinking: thinkingTokens };
}

// ─── Admin ─────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-change-me';
const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    log('warn', 'admin', 'admin_auth_failed', { ip: req.ip, path: req.path });
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

app.get('/admin', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const p = join(__dir, 'dashboard.html');
  res.send(existsSync(p) ? readFileSync(p, 'utf8') : '<h1>Dashboard not found</h1>');
});

app.post('/admin/users',    adminAuth, (req, res) => {
  try { res.json(createUser(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/admin/users',     adminAuth, (_, res) => res.json(getUsers()));
app.patch('/admin/users/:id', adminAuth, (req, res) => {
  const u = updateUser(req.params.id, req.body);
  u ? res.json(u) : res.status(404).json({ error: 'Not found' });
});
app.get('/admin/stats',     adminAuth, (req, res) =>
  res.json(getStats(req.query.user_id, parseInt(req.query.days || 7))));

app.get('/v1/usage', authenticate, (req, res) => {
  const { user } = req;
  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds, true);
  res.json({
    quota_per_window: user.quota_per_window,
    window_seconds: user.window_seconds,
    remaining: quota.remaining,
    reset_at: quota.resetAt ? new Date(quota.resetAt * 1000).toISOString() : null,
    stats: getStats(user.id, 7),
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ★ 404 Logging
app.use((req, res) => {
  log('warn', '-', '404_not_found', { path: req.path, method: req.method, ip: req.ip });
  res.status(404).json(anthropicError('not_found_error', `Endpoint ${req.path} not found`));
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Code Plan Proxy → port ${PORT}`);
  console.log(`📊 Admin  → http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}\n`);
  console.log('Client:');
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  export ANTHROPIC_AUTH_TOKEN=<api-key>\n`);
});
