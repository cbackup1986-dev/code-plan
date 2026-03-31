/**
 * Code Plan Proxy — 完整优化版
 *
 * 修复:
 * 1. hasMultimodalInput 提升到模块顶层，消除 ReferenceError
 * 2. handleOpenAIStream 里 toolAcc.accumulate → toolAcc.feed，getFinalToolCalls → getCompleted
 * 3. handleStream 里 Kimi 私有格式解析移入 try 块内，避免异常时 pingInterval 泄漏
 * 4. quota 内存缓存，避免每次请求都同步读写 quota_events.json
 * 5. stop_reason 判断、block index 独立追踪等原有修复保留
 */
import express from 'express';
import { randomUUID } from 'crypto';
import { readFileSync, existsSync, writeFileSync, appendFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

import {
  getUsers, getUserByKey, createUser, updateUser,
  checkAndConsumeQuota, recordUsage, recordConversation, getStats,
} from './db.js';
import {
  convertRequest, convertResponse, openAIToAnthropicMessages,
  mapStopReason, ToolCallAccumulator, ThinkingFilter, repairJSON,
} from './converter.js';
import {
  PROVIDERS,
  getProvider,
  VISION_CONFIG,
  AUDIO_CONFIG,
  TTS_CONFIG,
  IS_OFFLINE
} from './providers.js';
import { routeRequest } from './router.js';
import { processMultimodalMessages, hasMultimodalInput } from './multimodal.js';
import { synthesize, SentenceSplitter } from './tts.js';
import { handleRealtimeWebSocket } from './realtime.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = await import('http').then(http => http.createServer(app));
const wss = await import('ws').then(ws => new ws.WebSocketServer({ server, path: '/v1/realtime' }));

wss.on('connection', (ws, req) => {
  handleRealtimeWebSocket(ws, req);
});
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
const LOG_FILE  = process.env.LOG_FILE  || '';
const GLOBAL_TIMEOUT_MS = parseInt(process.env.GLOBAL_TIMEOUT_MS) || 0;

function log(level, reqId, msg, data = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  if (levels[level] < levels[LOG_LEVEL]) return;
  const ts = new Date().toISOString();
  const line = { ts, level, reqId, msg, ...data };
  
  // Console format for human readability
  const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '';
  const reset = '\x1b[0m';
  const time = ts.slice(11, 19);
  const shortId = reqId === '-' ? 'SYSTEM' : reqId.slice(0, 8);
  
  console.log(`${color}[${time}] [${level.toUpperCase()}] [${shortId}] ${msg}${reset}`, 
    Object.keys(data).length ? data : '');
  
  if (LOG_FILE) {
    const str = JSON.stringify(line);
    appendFile(LOG_FILE, str + '\n', () => {});
  }
}


// ─── Auth ──────────────────────────────────────────────────────────────────
export function authenticate(req, res, next) {
  const key = req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!key) {
    log('warn', '-', 'auth_failed', { reason: 'Missing API key', ip: req.ip });
    return res.status(401).json(anthropicError('authentication_error', 'Missing API key'));
  }
  const user = getUserByKey(key);
  if (!user) {
    log('warn', '-', 'auth_failed', { reason: 'Invalid API key', ip: req.ip });
    return res.status(401).json(anthropicError('authentication_error', 'Invalid API key'));
  }
  if (!user.active) {
    log('warn', '-', 'auth_failed', { reason: 'User disabled', user: user.username });
    return res.status(401).json(anthropicError('authentication_error', 'User account is disabled'));
  }
  req.user = user;
  if (next) next();
  return user;
}

export function anthropicError(type, message) {
  return { type: 'error', error: { type, message } };
}

// ─── 带超时和重试的 fetch ──────────────────────────────────────────────────
async function fetchWithRetry(url, options, timeoutMs, maxRetries = 2, signal = null) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    const combinedSignal = signal
      ? AbortSignal.any([ctrl.signal, signal])
      : ctrl.signal;

    try {
      const res = await fetch(url, { ...options, signal: combinedSignal });
      clearTimeout(timer);

      if (res.ok) return res;

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        lastErr = new Error(`Backend ${res.status}`);
        await sleep((attempt + 1) * 1500);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        if (signal?.aborted) throw new Error('Client disconnected');
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      lastErr = err;
      if (attempt < maxRetries) await sleep((attempt + 1) * 1500);
    }
  }
  throw lastErr;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── /v1/models ────────────────────────────────────────────────────────────
app.get(['/v1/models', '/models'], authenticate, (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-5-sonnet-20241022',  object: 'model', created: 1729555200, owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet-20240620',  object: 'model', created: 1718841600, owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet-latest',    object: 'model', created: 1729555200, owned_by: 'anthropic' },
      { id: 'claude-3-opus-20240229',      object: 'model', created: 1709164800, owned_by: 'anthropic' },
      { id: 'claude-3-sonnet-20240229',    object: 'model', created: 1709164800, owned_by: 'anthropic' },
      { id: 'claude-3-haiku-20240307',     object: 'model', created: 1709769600, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-20250514',    object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514',      object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-5',           object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-opus-4-5',             object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet',           object: 'model', created: 1720000000, owned_by: 'anthropic' },
      { id: 'claude-3-7-sonnet',           object: 'model', created: 1740000000, owned_by: 'anthropic' },
    ],
  });
});

// ─── /v1/sf/models ─────────────────────────────────────────────────────────
app.get('/v1/sf/models', authenticate, async (req, res) => {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SILICONFLOW_API_KEY not configured' });
  try {
    const sfRes = await fetch('https://api.siliconflow.cn/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!sfRes.ok) return res.status(sfRes.status).json({ error: `SiliconFlow API error: ${sfRes.status}` });
    res.json(await sfRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /v1/messages ──────────────────────────────────────────────────────────
app.post(['/v1/messages', '/messages'], authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body;
  const requestId = randomUUID();
  const isStream = body.stream === true;
  const originalModel = body.model || 'claude-sonnet-4-20250514';

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds);
  if (!quota.allowed) {
    const resetISO = new Date(quota.resetAt * 1000).toISOString();
    return res.status(429).json(anthropicError('rate_limit_error',
      `配额已用尽，将于 ${resetISO} 重置 (${user.quota_per_window}次/${Math.round(user.window_seconds / 3600)}h)`
    ));
  }
  const provider = getProvider(IS_OFFLINE ? 'ollama' : (user.provider || 'nvidia'));

  let routeDecision = null;
  if (provider.isRouter) {
    try {
      routeDecision = await routeRequest(
        body.messages || [], body.tools, originalModel,
        { apiKey: provider.apiKey, endpoint: provider.endpoint, disableSmartRouting: provider.disableSmartRouting },
      );
    } catch (err) {
      log('warn', requestId, 'router_failed', { error: err.message });
    }
  }

  const effectiveProvider = routeDecision
    ? { ...provider, endpoint: provider.backendEndpoint || provider.endpoint + '/chat/completions', modelMap: { default: routeDecision.model } }
    : provider;

  const topicOptions = routeDecision?.topic
    ? { 
        topic: routeDecision.topic, 
        topicTags: routeDecision.topicTags, 
        isSmallModel: routeDecision.isSmallModel,
        disableSmartRouting: provider.disableSmartRouting,
        isHeavyContext: routeDecision.isHeavyContext
      }
    : null;

  // 伪多模态处理
  if (!effectiveProvider.multimodal && hasMultimodalInput(body.messages)) {
    log('info', requestId, 'pseudo_multimodal_triggered', { model: originalModel });
    try {
      const processed = await processMultimodalMessages(
        body.messages, provider.visionConfig || VISION_CONFIG, provider.audioConfig || AUDIO_CONFIG,
        (level, sub, msg, data) => log(level, requestId, `${sub}_${msg}`, data),
        controller.signal,
      );
      if (processed.isChanged) body.messages = processed.messages;
    } catch (err) {
      log('error', requestId, 'pseudo_multimodal_failed', { error: err.message });
    }
  }

  const converted = convertRequest(body, effectiveProvider, topicOptions);
  const startTime = Date.now();

  log('info', requestId, '[Start] request', {
    user: user.username, model: originalModel, backend: converted.model,
    provider: user.provider, stream: isStream, ip: req.ip,
    messages: body.messages?.length, hasTools: !!body.tools?.length,
    ...(routeDecision ? {
      routed_intent: routeDecision.intent, routed_model: routeDecision.model,
      route_method: routeDecision.method, route_latency_ms: routeDecision.latency_ms,
    } : {}),
  });

  try {
    writeFileSync(join(__dir, '../last_request.json'), JSON.stringify(converted, null, 2));
  } catch (_) {}

  const forwardEndpoint = routeDecision
    ? (provider.backendEndpoint || (provider.endpoint.endsWith('/chat/completions') ? provider.endpoint : provider.endpoint + '/chat/completions'))
    : provider.endpoint;

  let backendRes;
  try {
    backendRes = await fetchWithRetry(
      forwardEndpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` }, body: JSON.stringify(converted) },
      GLOBAL_TIMEOUT_MS || provider.timeoutMs || 120000, 2, controller.signal,
    );
  } catch (err) {
    if (err.message === 'Client disconnected') {
      log('info', requestId, 'client_disconnected', { latency_ms: Date.now() - startTime });
      return;
    }
    log('error', requestId, 'fetch_failed', { error: err.message });
    return res.status(502).json(anthropicError('api_error', err.message));
  }

  if (!backendRes.ok) {
    const txt = await backendRes.text().catch(() => '');
    log('error', requestId, 'backend_error', { status: backendRes.status, body: txt.slice(0, 300) });
    return res.status(502).json(anthropicError('api_error', `Backend error ${backendRes.status}`));
  }

  log('info', requestId, 'backend_headers_received', { latency_ms: Date.now() - startTime });

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Quota-Remaining', String(quota.remaining));

    handleStream(backendRes.body, res, originalModel, requestId, provider, startTime, controller.signal)
      .then(metrics => {
        log('info', requestId, '[End] stream_done', { latency_ms: Date.now() - startTime, input_tokens: metrics.input, output_tokens: metrics.output });
        recordUsage({ user_id: user.id, request_id: requestId, claude_model: originalModel, backend_model: converted.model, input_tokens: metrics.input, output_tokens: metrics.output, latency_ms: Date.now() - startTime });
        recordConversation(requestId, { user_id: user.id, request: { model: originalModel, messages: body.messages, tools: body.tools }, response: { content: metrics.fullContent, usage: { input_tokens: metrics.input, output_tokens: metrics.output } }, latency_ms: Date.now() - startTime });
      })
      .catch(err => log('error', requestId, 'handle_stream_failed', { error: err.message }));
  } else {
    const data = await backendRes.json();
    const response = convertResponse(data, originalModel, requestId, provider);
    log('info', requestId, '[End] response', { latency_ms: Date.now() - startTime, stop_reason: response.stop_reason, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Quota-Remaining', String(quota.remaining));
    res.json(response);
    recordUsage({ user_id: user.id, request_id: requestId, claude_model: originalModel, backend_model: converted.model, input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0, latency_ms: Date.now() - startTime });
  }
});

// ─── /v1/chat/completions ──────────────────────────────────────────────────
app.post(['/v1/chat/completions', '/chat/completions'], authenticate, async (req, res) => {
  const { user } = req;
  const body = req.body;
  const requestId = randomUUID();
  const isStream = body.stream === true;
  const originalModel = body.model || 'gpt-4o';

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds);
  if (!quota.allowed) {
    const resetISO = new Date(quota.resetAt * 1000).toISOString();
    return res.status(429).json({ error: { message: `配额已用尽，将于 ${resetISO} 重置`, type: 'rate_limit_error' } });
  }

  const provider = getProvider(IS_OFFLINE ? 'ollama' : (user.provider || 'nvidia'));
  const anthropicMessages = openAIToAnthropicMessages(body.messages || []);

  let routeDecision = null;
  if (provider.isRouter) {
    try {
      routeDecision = await routeRequest(anthropicMessages, body.tools, originalModel, { apiKey: provider.apiKey, endpoint: provider.endpoint });
    } catch (err) {
      log('warn', requestId, 'router_failed', { error: err.message });
    }
  }

  const effectiveProvider = routeDecision
    ? { ...provider, endpoint: provider.backendEndpoint || provider.endpoint + '/chat/completions', modelMap: { default: routeDecision.model } }
    : provider;

  // ★ hasMultimodalInput 现在在模块顶层，不再有 ReferenceError
  let processedMessages = anthropicMessages;
  if (!effectiveProvider.multimodal && hasMultimodalInput(anthropicMessages)) {
    log('info', requestId, 'pseudo_multimodal_triggered_openai', { model: originalModel });
    try {
      const processed = await processMultimodalMessages(
        anthropicMessages, effectiveProvider.visionConfig || VISION_CONFIG, effectiveProvider.audioConfig || AUDIO_CONFIG,
        (level, sub, msg, data) => log(level, requestId, `openai_${sub}_${msg}`, data),
        controller.signal,
      );
      if (processed.isChanged) processedMessages = processed.messages;
    } catch (err) {
      log('error', requestId, 'pseudo_multimodal_failed_openai', { error: err.message });
    }
  }

  const topicOptions = routeDecision?.topic
    ? { 
        topic: routeDecision.topic, 
        topicTags: routeDecision.topicTags, 
        isSmallModel: routeDecision.isSmallModel,
        disableSmartRouting: provider.disableSmartRouting,
        isHeavyContext: routeDecision.isHeavyContext
      }
    : null;

  const converted = convertRequest({ ...body, messages: processedMessages }, effectiveProvider, topicOptions);
  if (controller.signal.aborted) return;

  const startTime = Date.now();
  log('info', requestId, '[Start] request_openai', { user: user.username, model: originalModel, backend: converted.model, provider: user.provider, stream: isStream, ip: req.ip });

  const forwardEndpoint = routeDecision
    ? (provider.backendEndpoint || (provider.endpoint.endsWith('/chat/completions') ? provider.endpoint : provider.endpoint + '/chat/completions'))
    : provider.endpoint;

  let backendRes;
  try {
    backendRes = await fetchWithRetry(
      forwardEndpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` }, body: JSON.stringify(converted) },
      GLOBAL_TIMEOUT_MS || provider.timeoutMs || 120000, 2, controller.signal,
    );
  } catch (err) {
    if (err.message === 'Client disconnected') {
      log('info', requestId, 'client_disconnected_openai', { latency_ms: Date.now() - startTime });
      return;
    }
    if (res.writableEnded || res.closed) return;
    log('error', requestId, 'fetch_failed_openai', { error: err.message });
    return res.status(502).json({ error: { message: err.message, type: 'api_error' } });
  }

  if (res.writableEnded || res.closed) return;

  if (!backendRes.ok) {
    const txt = await backendRes.text().catch(() => '');
    log('error', requestId, 'backend_error_openai', { status: backendRes.status, body: txt.slice(0, 300) });
    return res.status(502).json({ error: { message: `Backend error ${backendRes.status}`, type: 'api_error' } });
  }

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const enableTTS = body.modalities?.includes('audio') || (body.audio && !body.audio.disabled);
    handleOpenAIStream(backendRes.body, res, requestId, provider, startTime, enableTTS, controller.signal)
      .then(metrics => {
        log('info', requestId, '[End] stream_done_openai', { latency_ms: Date.now() - startTime, input_tokens: metrics.input, output_tokens: metrics.output });
        recordUsage({ user_id: user.id, request_id: requestId, claude_model: originalModel, backend_model: converted.model, input_tokens: metrics.input, output_tokens: metrics.output, latency_ms: Date.now() - startTime });
        recordConversation(requestId, { user_id: user.id, request: { model: originalModel, messages: body.messages }, response: { content: metrics.fullContent, usage: { input_tokens: metrics.input, output_tokens: metrics.output } }, latency_ms: Date.now() - startTime });
      })
      .catch(err => { if (!res.writableEnded && !res.closed) log('error', requestId, 'handle_openai_stream_failed', { error: err.message }); });
  } else {
    const data = await backendRes.json();
    log('info', requestId, '[End] response_openai', { latency_ms: Date.now() - startTime, input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 });
    res.json(data);
    recordUsage({ user_id: user.id, request_id: requestId, claude_model: originalModel, backend_model: converted.model, input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0, latency_ms: Date.now() - startTime });
  }
});

// ─── OpenAI 格式流处理（修复 accumulate/getFinalToolCalls） ─────────────────
export async function handleOpenAIStream(stream, res, requestId, provider, startTime, enableTTS = false, signal = null) {
  let inputTokens = 0, outputTokens = 0;
  let fullContent = [];
  const thinkFilter = provider.stripThinking ? new ThinkingFilter() : null;
  const ttsSplitter = enableTTS ? new SentenceSplitter() : null;
  const decoder = new TextDecoder();
  let buffer = '';

  let currentText = '';
  let currentThinking = '';
  // ★ 修复：ToolCallAccumulator 只有 feed() 和 getCompleted()
  const toolAcc = new ToolCallAccumulator();

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }

        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }

        if (data.usage) { inputTokens = data.usage.prompt_tokens; outputTokens = data.usage.completion_tokens; }

        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          currentText += delta.content;
          const filtered = thinkFilter ? thinkFilter.feed(delta.content) : delta.content;
          
          if (ttsSplitter && filtered) {
            const sentences = ttsSplitter.feed(filtered);
            for (const s of sentences) {
              (async () => {
                try {
                  const audio = await synthesize(s, provider.ttsConfig || TTS_CONFIG, signal);
                  if (!res.writableEnded) {
                    res.write(`data: ${JSON.stringify({
                      choices: [{ delta: { audio: { data: audio.toString('base64'), transcript: s } } }]
                    })}\n\n`);
                  }
                } catch (e) { log('warn', requestId, 'tts_stream_failed', { error: e.message }); }
              })();
            }
          }

          if (filtered) delta.content = filtered;
          else delete delta.content;
        }

        if (delta.reasoning_content) currentThinking += delta.reasoning_content;

        // ★ 修复：feed() 接受数组，getCompleted() 取结果
        if (delta.tool_calls) toolAcc.feed(delta.tool_calls);

        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    }

    if (ttsSplitter) {
      const lastSentence = ttsSplitter.flush();
      if (lastSentence) {
        try {
          const audio = await synthesize(lastSentence, provider.ttsConfig || TTS_CONFIG, signal);
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({
              choices: [{ delta: { audio: { data: audio.toString('base64'), transcript: lastSentence } } }]
            })}\n\n`);
          }
        } catch (e) { log('warn', requestId, 'tts_stream_final_failed', { error: e.message }); }
      }
    }
  } catch (err) {
    if (!res.writableEnded && !res.closed) log('error', requestId, 'stream_error_openai', { error: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }

  if (currentThinking) fullContent.push({ type: 'thinking', thinking: currentThinking });
  if (currentText)     fullContent.push({ type: 'text', text: currentText });

  // ★ 修复：getCompleted() 而非 getFinalToolCalls()
  for (const tc of toolAcc.getCompleted()) {
    let input = {};
    try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
    fullContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }

  return { input: inputTokens, output: outputTokens, fullContent };
}

// ─── Anthropic 流式处理（完整修复版） ─────────────────────────────────────
async function handleStream(stream, res, originalModel, requestId, provider, startTime, signal = null) {
  const msgId = `msg_${requestId.replace(/-/g, '').slice(0, 24)}`;
  let inputTokens = 0, outputTokens = 0;
  let fullContent = [];

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: { id: msgId, type: 'message', role: 'assistant', model: originalModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  send('ping', { type: 'ping' });

  let textBlockIndex = -1,    textBlockOpen = false;
  let reasoningBlockIndex = -1, reasoningBlockOpen = false;
  let nextBlockIndex = 0;

  const toolAcc = new ToolCallAccumulator();
  const suppressedIndices = new Set();
  const validToolBlockIndices = new Map();
  const pendingToolBlocks = new Map(); // ★ 缓冲分片的 tool call（id/name 可能不在同一个 chunk）
  let hasToolCalls = false;
  let finishReason = null;
  let usageFromChunk = null;

  const thinkFilter = provider.stripThinking ? new ThinkingFilter() : null;

  let buffer = '';
  let thinkingContent = '';
  let textContent = '';

  let kimiReasoningBuf = '';
  let kimiInToolSection = false;

  let stopReason = 'stop';
  let finalOutput = 0;
  let thinkingTokens = 0;

  let chunkCount = 0;
  let hasOutputContent = false; // ★ 必须在循环外声明，追踪整个流是否输出了内容
  const pingInterval = setInterval(() => {
    if (chunkCount === 0) send('ping', { type: 'ping' });
  }, 15000);

  try {
    const decoder = new TextDecoder();

    for await (const chunk of stream) {
      if (signal?.aborted) { log('warn', requestId, 'stream_aborted'); break; }
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
        // ── 文本 delta ────────────────────────────────────────────────────
        if (delta.content) {
          textContent += delta.content;
          const text = thinkFilter ? thinkFilter.feed(delta.content) : delta.content;
          if (text) {
            if (reasoningBlockOpen) {
              send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
              reasoningBlockOpen = false;
            }
            if (!textBlockOpen) {
              textBlockIndex = nextBlockIndex++;
              send('content_block_start', { type: 'content_block_start', index: textBlockIndex, content_block: { type: 'text', text: '' } });
              fullContent.push({ type: 'text', text: '' });
              textBlockOpen = true;
            }
            send('content_block_delta', { type: 'content_block_delta', index: textBlockIndex, delta: { type: 'text_delta', text } });
            const block = fullContent[fullContent.length - 1];
            if (block && block.type === 'text') block.text += text;
            outputTokens++;
            hasOutputContent = true;
          }
        }

        // ── 推理 delta ────────────────────────────────────────────────────
        const hasToolCallsInChunk = !!(delta.tool_calls?.length);
        if (delta.reasoning_content && !hasToolCallsInChunk) {
          kimiReasoningBuf += delta.reasoning_content;

          if (kimiReasoningBuf.includes('<|tool_calls_section_begin|>')) {
            kimiInToolSection = true;
          }

          if (!kimiInToolSection) {
            const text = delta.reasoning_content;
            const isPlaceholder = [' ', 'Thought process preserved.', 'NO', 'Thinking', 'Thinking...'].includes(text);
            if (isPlaceholder && !thinkingContent) continue;

            if (!reasoningBlockOpen) {
              if (textBlockOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
                textBlockOpen = false;
              }
              reasoningBlockIndex = nextBlockIndex++;
              send('content_block_start', { type: 'content_block_start', index: reasoningBlockIndex, content_block: { type: 'thinking', thinking: '' } });
              reasoningBlockOpen = true;
            }
            send('content_block_delta', { type: 'content_block_delta', index: reasoningBlockIndex, delta: { type: 'thinking_delta', thinking: text } });
            thinkingContent += text;
          }
        }

        if (hasToolCallsInChunk && reasoningBlockOpen) {
          send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex });
          reasoningBlockOpen = false;
        }

        // ── 工具调用 delta ────────────────────────────────────────────────
        // ★ 修复：Qwen/vLLM 等后端经常将 id 和 name 拆分到不同 chunk 中发送
        //   如果在 name 为空时就向 Anthropic SDK 发送 content_block_start，
        //   SDK 会因空 name 而崩溃，导致 OpenClaw 界面卡死
        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.function?.name === 'think') { suppressedIndices.add(idx); continue; }
            if (suppressedIndices.has(idx)) continue;

            hasToolCalls = true;

            // ── 积累 pending 状态 ──
            if (!pendingToolBlocks.has(idx) && (tc.id || tc.function?.name)) {
              pendingToolBlocks.set(idx, { id: tc.id || '', name: tc.function?.name || '', bufferedArgs: '' });
            } else if (pendingToolBlocks.has(idx)) {
              const p = pendingToolBlocks.get(idx);
              if (tc.id && !p.id) p.id = tc.id;
              if (tc.function?.name && !p.name) p.name += tc.function.name;
            }

            // ── 尝试 flush：只有当 id 和 name 都已到齐时才发送 ──
            const pending = pendingToolBlocks.get(idx);
            if (pending && pending.id && pending.name && !validToolBlockIndices.has(idx)) {
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
              send('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: pending.id, name: pending.name } });
              fullContent.push({ type: 'tool_use', id: pending.id, name: pending.name, input: '' });
              hasOutputContent = true;

              // flush 之前缓冲的 arguments
              if (pending.bufferedArgs) {
                send('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: pending.bufferedArgs } });
                const block = fullContent.find(b => b.id === pending.id);
                if (block) block.input = (block.input || '') + pending.bufferedArgs;
              }
              pendingToolBlocks.delete(idx);
            }

            // ── 处理 arguments delta ──
            if (tc.function?.arguments) {
              const blockIdx = validToolBlockIndices.get(idx);
              if (blockIdx !== undefined) {
                // block 已 flush，直接发送
                send('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
                const block = fullContent.find(b => b.type === 'tool_use' && validToolBlockIndices.get(idx) === blockIdx);
                if (block) block.input = (block.input || '') + tc.function.arguments;
              } else if (pendingToolBlocks.has(idx)) {
                // block 尚未 flush，缓冲 arguments
                pendingToolBlocks.get(idx).bufferedArgs += tc.function.arguments;
              }
            }
          }
          toolAcc.feed(delta.tool_calls);
        }
      }
    }

    // ★ 安全网：流结束时 flush 所有未完成的 pending tool blocks
    // 如果后端在 id/name 分两个 chunk 发送后就结束了流，我们仍需要发送它们
    for (const [idx, pending] of pendingToolBlocks.entries()) {
      if (validToolBlockIndices.has(idx)) continue; // 已经 flush 过
      // 生成 fallback
      if (!pending.id) pending.id = `toolu_${requestId.replace(/-/g, '').slice(0, 24)}`;
      if (!pending.name) {
        log('warn', requestId, 'tool_call_missing_name', { idx, id: pending.id });
        pending.name = 'unknown_tool'; // 兜底名称，防止 SDK 崩溃
      }
      if (reasoningBlockOpen) { send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex }); reasoningBlockOpen = false; }
      if (textBlockOpen) { send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex }); textBlockOpen = false; }
      const blockIdx = nextBlockIndex++;
      validToolBlockIndices.set(idx, blockIdx);
      send('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: pending.id, name: pending.name } });
      fullContent.push({ type: 'tool_use', id: pending.id, name: pending.name, input: '' });
      hasOutputContent = true;
      if (pending.bufferedArgs) {
        send('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: pending.bufferedArgs } });
        const block = fullContent.find(b => b.id === pending.id);
        if (block) block.input = (block.input || '') + pending.bufferedArgs;
      }
      send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
    }
    pendingToolBlocks.clear();

    // ★ 修复：Kimi 私有格式解析移入 try 块，确保 pingInterval 在 finally 中被清理
    const isKimi = originalModel.toLowerCase().includes('kimi');
    if (isKimi && kimiInToolSection && kimiReasoningBuf.includes('<|tool_calls_section_begin|>')) {
      try {
        const marker = '<|tool_calls_section_begin|>';
        const jsonStart = kimiReasoningBuf.indexOf(marker) + marker.length;
        let jsonStr = kimiReasoningBuf.slice(jsonStart).trim();
        const endMarker = '<|tool_calls_section_end|>';
        if (jsonStr.includes(endMarker)) jsonStr = jsonStr.slice(0, jsonStr.indexOf(endMarker));

        const kimiTools = JSON.parse(jsonStr);
        log('info', requestId, 'kimi_private_toolcall_parsed', { count: kimiTools.length, names: kimiTools.map(t => t.name) });

        if (reasoningBlockOpen) { send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex }); reasoningBlockOpen = false; }
        if (textBlockOpen) { send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex }); textBlockOpen = false; }

        for (let i = 0; i < kimiTools.length; i++) {
          const kt = kimiTools[i];
          if (!kt.name) continue;
          const blockIdx = nextBlockIndex++;
          const toolId = `toulu_kimi_${requestId.replace(/-/g, '').slice(0, 16)}_${i}`;
          send('content_block_start', { type: 'content_block_start', index: blockIdx, content_block: { type: 'tool_use', id: toolId, name: kt.name } });
          const argsStr = JSON.stringify(kt.parameters ?? kt.arguments ?? kt.input ?? {});
          send('content_block_delta', { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: argsStr } });
          send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
          hasToolCalls = true;
          hasOutputContent = true;
          validToolBlockIndices.set(`kimi_${i}`, -1);
        }
      } catch (err) {
        log('warn', requestId, 'kimi_toolcall_parse_failed', { error: err.message });
      }
    }

    // 关闭所有未关闭的 block
    if (reasoningBlockOpen) { send('content_block_stop', { type: 'content_block_stop', index: reasoningBlockIndex }); reasoningBlockOpen = false; }
    if (textBlockOpen)      { send('content_block_stop', { type: 'content_block_stop', index: textBlockIndex }); textBlockOpen = false; }
    for (const blockIdx of validToolBlockIndices.values()) {
      if (blockIdx === -1) continue;
      send('content_block_stop', { type: 'content_block_stop', index: blockIdx });
    }

    // 兜底：如果整个流只输出了 thinking 却没有输出 text 或 tool_use，注入一个空格
    // 这是为了满足 Anthropic 协议要求：assistant 消息不能没有非 thinking 内容
    if (!hasOutputContent) {
      const idx = nextBlockIndex++;
      send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: ' ' } });
      send('content_block_stop', { type: 'content_block_stop', index: idx });
      textContent = ' '; // ★ 确保日志中记录下由于没输出而被塞入的 fallback 空格
    }

    stopReason = hasToolCalls ? 'tool_use' : mapStopReason(finishReason, false);
    finalOutput  = usageFromChunk?.completion_tokens || outputTokens;
    inputTokens  = usageFromChunk?.prompt_tokens || 0;
    thinkingTokens = thinkFilter
      ? Math.ceil(thinkFilter.getThinking().length / 4)
      : Math.ceil(thinkingContent.length / 4);

    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: finalOutput } });
    send('message_stop', { type: 'message_stop' });

  } catch (err) {
    if (!res.writableEnded && !res.closed) log('error', requestId, 'stream_error', { error: err.message });
  } finally {
    clearInterval(pingInterval);
    if (!res.writableEnded && !res.closed) res.end();
  }

  if (thinkingContent) fullContent.push({ type: 'thinking', thinking: thinkingContent });
  if (textContent)     fullContent.push({ type: 'text', text: textContent });

  for (const tc of toolAcc.getCompleted()) {
    let input = {};
    try { input = JSON.parse(tc.arguments || '{}'); } catch { input = {}; }
    fullContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
  }

  return { input: inputTokens, output: finalOutput, thinking: thinkingTokens, fullContent };
}

// ─── Admin ─────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin-secret-change-me';
const adminAuth = (req, res, next) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    log('warn', 'admin', 'admin_auth_failed', { ip: req.ip });
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
  try { res.json(createUser(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/admin/users',       adminAuth, (_, res) => res.json(getUsers()));
app.patch('/admin/users/:id', adminAuth, (req, res) => {
  const u = updateUser(req.params.id, req.body);
  u ? res.json(u) : res.status(404).json({ error: 'Not found' });
});
app.get('/admin/stats', adminAuth, (req, res) =>
  res.json(getStats(req.query.user_id, parseInt(req.query.days || 7))));

app.get('/v1/usage', authenticate, (req, res) => {
  const { user } = req;
  const requestId = randomUUID();
  const startTime = Date.now();
  log('info', requestId, '[Start] usage_request', { user: user.username, ip: req.ip });
  const quota = checkAndConsumeQuota(user.id, user.quota_per_window, user.window_seconds, true);
  res.json({
    quota_per_window: user.quota_per_window,
    window_seconds: user.window_seconds,
    remaining: quota.remaining,
    reset_at: quota.resetAt ? new Date(quota.resetAt * 1000).toISOString() : null,
    stats: getStats(user.id, 7),
  });
  log('info', requestId, '[End] usage_response', { latency_ms: Date.now() - startTime });
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use((req, res) => {
  log('warn', '-', '404_not_found', { path: req.path, method: req.method });
  res.status(404).json(anthropicError('not_found_error', `Endpoint ${req.path} not found`));
});

// ─── /v1/audio/speech (TTS) ────────────────────────────────────────────────
app.post(['/v1/audio/speech', '/audio/speech'], authenticate, async (req, res) => {
  const { user } = req;
  const { input, model, voice, response_format } = req.body;
  const requestId = randomUUID();

  if (!input) {
    return res.status(400).json({ error: { message: 'Missing input text', type: 'invalid_request_error' } });
  }

  const provider = getProvider(user.provider || 'nvidia');
  const ttsConfig = provider.ttsConfig || TTS_CONFIG;

  log('info', requestId, '[Start] tts_request', { user: user.username, model: model || ttsConfig.model, input: input.slice(0, 50) + '...', ip: req.ip });

  try {
    const audioBuffer = await synthesize(input, {
      ...ttsConfig,
      model: model || ttsConfig.model,
      voice: voice || ttsConfig.voice,
    }, req.signal); // 使用请求的中止信号

    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
    
    log('info', requestId, '[End] tts_done', { size: audioBuffer.length, latency_ms: Date.now() - startTime });
  } catch (err) {
    if (err.name === 'AbortError') {
      return log('warn', requestId, 'tts_aborted');
    }
    log('error', requestId, 'tts_failed', { error: err.message });
    res.status(500).json({ error: { message: err.message, type: 'api_error' } });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Code Plan Proxy → port ${PORT}`);
  console.log(`📊 Admin  → http://localhost:${PORT}/admin`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}\n`);
  console.log('Client:');
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  export ANTHROPIC_AUTH_TOKEN=<api-key>\n`);
});
