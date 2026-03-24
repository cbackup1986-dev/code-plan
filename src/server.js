/**
 * Code Plan Proxy — 完整优化版
 *
 * 修复:
 * 1. stop_reason 基于 hasToolCalls 强制判断，不依赖 finish_reason 时序
 * 2. text block / tool block 各自独立追踪 blockIndex，消除关闭时 index 冲突
 * 3. 新增 /v1/models 端点（OpenClaw / Cursor 兼容）
 * 4. 流结束后 stop_reason 判断移到所有 block 关闭之后
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
import { routeRequest } from './router.js';

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
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

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

// ─── 带超时和重试的 fetch ──────────────────────────────────────────────────
async function fetchWithRetry(url, options, timeoutMs, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) return res;

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const wait = (attempt + 1) * 1500;
        lastErr = new Error(`Backend ${res.status}`);
        await sleep(wait);
        continue;
      }

      return res;
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

// ─── /v1/models — OpenClaw / Cursor 兼容端点 ★ ────────────────────────────
app.get(['/v1/models', '/models'], authenticate, (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-sonnet-4-20250514',  object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514',    object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-5',         object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-opus-4-5',           object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5',          object: 'model', created: 1700000000, owned_by: 'anthropic' },
    ],
  });
});

// ─── /v1/messages ──────────────────────────────────────────────────────────
app.post(['/v1/messages', '/messages'], authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body;
  const requestId = randomUUID();
  const isStream = body.stream === true;
  const originalModel = body.model || 'claude-sonnet-4-20250514';

  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds);
  if (!quota.allowed) {
    const resetISO = new Date(quota.resetAt * 1000).toISOString();
    return res.status(429).json(anthropicError('rate_limit_error',
      `配额已用尽，将于 ${resetISO} 重置 (${user.quota_per_window}次/${Math.round(user.window_seconds/3600)}h)`
    ));
  }

  const provider = getProvider(user.provider || 'nvidia');

  // ★ 智能路由：auto_router provider 先识别意图，再动态选模型
  let routeDecision = null;
  if (provider.isRouter) {
    try {
      routeDecision = await routeRequest(
        body.messages || [],
        body.tools,
        originalModel,
        { apiKey: provider.apiKey, endpoint: provider.endpoint },
      );
    } catch (err) {
      log('warn', requestId, 'router_failed', { error: err.message });
    }
  }

  // 如果路由成功，动态覆盖 provider 的 modelMap
  const effectiveProvider = routeDecision
    ? {
        ...provider,
        endpoint: provider.backendEndpoint || provider.endpoint + '/chat/completions',
        modelMap: { default: routeDecision.model },
      }
    : provider;

  const converted = convertRequest(body, effectiveProvider);
  const startTime = Date.now();

  log('info', requestId, 'request', {
    user: user.username,
    model: originalModel,
    backend: converted.model,
    provider: user.provider,
    ...(routeDecision ? {
      routed_intent: routeDecision.intent,
      routed_model: routeDecision.model,
      route_method: routeDecision.method,
      route_latency_ms: routeDecision.latency_ms,
    } : {}),
    stream: isStream,
    messages: body.messages?.length,
    hasTools: !!body.tools?.length,
  });

  try {
    writeFileSync('e:/ai/code-plan-proxy/code-plan/last_request.json', JSON.stringify(converted, null, 2));
  } catch(e) {}

  // 转发端点：auto_router 用 backendEndpoint，其他用 provider.endpoint
  const forwardEndpoint = routeDecision
    ? (provider.backendEndpoint || provider.endpoint + '/chat/completions')
    : provider.endpoint;

  let backendRes;
  try {
    backendRes = await fetchWithRetry(
      forwardEndpoint,
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

// ─── 流式处理 ★ 完整修复版 ───────────────────────────────────────────────────
async function handleStream(stream, res, originalModel, requestId, provider, startTime) {
  const msgId = `msg_${requestId.replace(/-/g, '').slice(0, 24)}`;
  let inputTokens = 0, outputTokens = 0;

  const send = (event, data) => {
    console.log(`DEBUG [${requestId}] send event: ${event}`, JSON.stringify(data).slice(0, 150));
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

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

  // ★ 修复：text block 和 reasoning block 各自独立记录 blockIndex
  let textBlockIndex = -1;       // text block 占用的 index
  let textBlockOpen = false;
  let reasoningBlockIndex = -1;  // reasoning block 占用的 index
  let reasoningBlockOpen = false;

  const toolAcc = new ToolCallAccumulator();
  const suppressedIndices = new Set();
  let hasToolCalls = false;
  let finishReason = null;
  let usageFromChunk = null;

  const thinkFilter = provider.stripThinking ? new ThinkingFilter() : null;

  let buffer = '';
  let thinkingContent = '';

  // Kimi-K2.5 私有格式：工具调用通过 reasoning_content 传出，带特殊标记
  let kimiReasoningBuf = '';   // 积累全部 reasoning_content
  let kimiInToolSection = false; // 是否已进入工具调用区段

  // ★ 全局 block index 计数器，所有 block（text/reasoning/tool）统一分配
  let nextBlockIndex = 0;

  // tool block 映射：OpenAI tool index -> Anthropic block index
  const validToolBlockIndices = new Map();

  let chunkCount = 0;
  const pingInterval = setInterval(() => {
    if (chunkCount === 0) {
      send('ping', { type: 'ping' });
    }
  }, 15000);

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

        // ── 文本 delta ──────────────────────────────────────────────────────
        if (delta.content) {
          console.log(`DEBUG [${requestId}] content:`, delta.content);
          const text = thinkFilter ? thinkFilter.feed(delta.content) : delta.content;
          if (text) {
            // reasoning block 如果还开着，先关掉
            if (reasoningBlockOpen) {
              send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
              reasoningBlockOpen = false;
            }
            if (!textBlockOpen) {
              textBlockIndex = nextBlockIndex++;
              send('content_block_start', {
                type: 'content_block_start', index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              });
              textBlockOpen = true;
            }
            send('content_block_delta', {
              type: 'content_block_delta', index: textBlockIndex,
              delta: { type: 'text_delta', text },
            });
            outputTokens++;
          }
        }

        // ── 推理 delta ──────────────────────────────────────────────────────
        // Kimi-K2.5 在 SiliconFlow 上有一个严重 bug：
        //   它不通过标准 tool_calls 字段输出工具调用，而是把整个工具调用序列
        //   （包括私有标记 <|tool_calls_section_begin|> 和 JSON）塞进 reasoning_content
        // 需要：1) 识别这个标记  2) 从 reasoning 里解析出工具调用  3) 正常转发
        const hasToolCallsInThisChunk = !!(delta.tool_calls?.length);
        if (delta.reasoning_content && !hasToolCallsInThisChunk) {
          kimiReasoningBuf += delta.reasoning_content;

          // 检测到 Kimi 私有工具调用标记
          if (kimiReasoningBuf.includes('<|tool_calls_section_begin|>')) {
            kimiInToolSection = true;
          }

          if (kimiInToolSection) {
            // 积累工具调用 JSON，等流结束后统一解析
            // 不发送到客户端（不是真正的 thinking）
          } else {
            // 正常 thinking 内容，发给客户端
            const text = delta.reasoning_content;

            // ★ 改进：如果推理内容仅仅是单个空格或特定的占位符，且还没有真正的思考内容，直接忽略
            // 避免在 UI 中产生一个空洞的 "Thinking" 块。只有当内容非占位符时才开启 block。
            const isPlaceholder = (text === ' ' || text === 'Thought process preserved.');
            if (isPlaceholder && !thinkingContent) {
              return;
            }

            if (!reasoningBlockOpen) {
              if (textBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
                textBlockOpen = false;
              }
              reasoningBlockIndex = nextBlockIndex++;
              send('content_block_start', {
                type: 'content_block_start', index: reasoningBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              });
              reasoningBlockOpen = true;
            }
            send('content_block_delta', {
              type: 'content_block_delta', index: reasoningBlockIndex,
              delta: { type: 'thinking_delta', thinking: text },
            });
            thinkingContent += text;
          }
        }

        // reasoning block 结束：有标准 tool_calls 时关闭
        if (hasToolCallsInThisChunk && reasoningBlockOpen) {
          send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
          reasoningBlockOpen = false;
        }

        // ── 工具调用 delta ──────────────────────────────────────────────────
        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.function?.name === 'think') {
              suppressedIndices.add(idx);
              continue;
            }
            if (suppressedIndices.has(idx)) continue;

            hasToolCalls = true;

            if (tc.id) {
              // 新工具块开始：先关闭 reasoning/text block
              if (reasoningBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
                reasoningBlockOpen = false;
              }
              if (textBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
                textBlockOpen = false;
              }

              const blockIdx = nextBlockIndex++;
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

  // ── Kimi 私有格式工具调用解析 ────────────────────────────────────────────
  // 如果检测到了 <|tool_calls_section_begin|>，从积累的 buf 里解析工具调用
  // 格式示例（reasoning_content 积累后）：
  //   ...正常思考...<|tool_calls_section_begin|>[{"name":"browser","parameters":{...}}]
  if (kimiInToolSection && kimiReasoningBuf.includes('<|tool_calls_section_begin|>')) {
    try {
      const marker = '<|tool_calls_section_begin|>';
      const jsonStart = kimiReasoningBuf.indexOf(marker) + marker.length;
      let jsonStr = kimiReasoningBuf.slice(jsonStart).trim();

      // 可能有结束标记，截断
      const endMarker = '<|tool_calls_section_end|>';
      if (jsonStr.includes(endMarker)) {
        jsonStr = jsonStr.slice(0, jsonStr.indexOf(endMarker));
      }

      const kimiTools = JSON.parse(jsonStr);
      log('info', requestId, 'kimi_private_toolcall_parsed', {
        count: kimiTools.length,
        names: kimiTools.map(t => t.name),
      });

      // 关闭 reasoning block（如果还开着）
      if (reasoningBlockOpen) {
        send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
        reasoningBlockOpen = false;
      }
      if (textBlockOpen) {
        send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
        textBlockOpen = false;
      }

      // 把解析出的工具调用转成标准 Anthropic tool_use blocks
      for (let i = 0; i < kimiTools.length; i++) {
        const kt = kimiTools[i];
        if (!kt.name) continue;
        const blockIdx = nextBlockIndex++;
        const toolId = `toolu_kimi_${requestId.replace(/-/g,'').slice(0,16)}_${i}`;

        send('content_block_start', {
          type: 'content_block_start', index: blockIdx,
          content_block: { type: 'tool_use', id: toolId, name: kt.name },
        });
        const argsStr = JSON.stringify(kt.parameters ?? kt.arguments ?? kt.input ?? {});
        send('content_block_delta', {
          type: 'content_block_delta', index: blockIdx,
          delta: { type: 'input_json_delta', partial_json: argsStr },
        });
        send('content_block_stop', { type: 'content_block_stop', index: blockIdx });

        // 标记为有工具调用（影响 stop_reason）
        hasToolCalls = true;
        // 防止下面的 validToolBlockIndices 循环重复关闭
        validToolBlockIndices.set(`kimi_${i}`, -1); // -1 表示已关闭
      }
    } catch (err) {
      log('warn', requestId, 'kimi_toolcall_parse_failed', { error: err.message, buf: kimiReasoningBuf.slice(-200) });
    }
  }

  // ★ 修复：按独立 index 关闭各 block，顺序：reasoning → text → tools
  if (reasoningBlockOpen) {
    send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
    reasoningBlockOpen = false;
  }

  if (textBlockOpen) {
    send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    textBlockOpen = false;
  }

  for (const blockIdx of validToolBlockIndices.values()) {
    if (blockIdx === -1) continue; // 已由 Kimi 解析器关闭，跳过
    send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
  }

  // 兜底：没有任何内容时发空 text block
  if (nextBlockIndex === 0) {
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
  }

  // ★ 修复：stop_reason 必须在所有 block 关闭后判断
  // 只要有工具调用，无论 finish_reason 是什么，都返回 tool_use
  // 这修复了 finish_reason 为 null/stop 时 OpenClaw loop 中断的问题
  const stopReason = hasToolCalls ? 'tool_use' : mapStopReason(finishReason, false);

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

app.post('/admin/users',      adminAuth, (req, res) => {
  try { res.json(createUser(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/admin/users',       adminAuth, (_, res) => res.json(getUsers()));
app.patch('/admin/users/:id', adminAuth, (req, res) => {
  const u = updateUser(req.params.id, req.body);
  u ? res.json(u) : res.status(404).json({ error: 'Not found' });
});
app.get('/admin/stats',       adminAuth, (req, res) =>
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

// 404
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
