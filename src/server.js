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

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

import {
  getUsers, getUserByKey, createUser, updateUser,
  checkAndConsumeQuota, recordUsage, recordConversation
} from './db.js';
import {
  convertRequest, convertResponse, openAIToAnthropicMessages,
  mapStopReason, ToolCallAccumulator, ThinkingFilter, repairJSON,
} from './converter.js';
import { getProvider, VISION_CONFIG, AUDIO_CONFIG } from './providers.js';
import { routeRequest } from './router.js';
import { processMultimodalMessages } from './multimodal.js';

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
async function fetchWithRetry(url, options, timeoutMs, maxRetries = 2, signal = null) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const TIMEOUT_MS = timeoutMs || 60000;
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    // 组合外部 signal
    const combinedSignal = signal ? AbortSignal.any([ctrl.signal, signal]) : ctrl.signal;

    try {
      const res = await fetch(url, { ...options, signal: combinedSignal });
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
      { 
        id: 'claude-3-5-sonnet-20241022', 
        object: 'model', created: 1729555200, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 8192
      },
      { 
        id: 'claude-3-5-sonnet-20240620', 
        object: 'model', created: 1718841600, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 8192
      },
      { 
        id: 'claude-3-5-sonnet-latest', 
        object: 'model', created: 1729555200, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 8192
      },
      { 
        id: 'claude-3-opus-20240229', 
        object: 'model', created: 1709164800, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 4096
      },
      { 
        id: 'claude-3-sonnet-20240229', 
        object: 'model', created: 1709164800, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 4096
      },
      { 
        id: 'claude-3-haiku-20240307', 
        object: 'model', created: 1709769600, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 4096
      },
      { 
        id: 'claude-sonnet-4-20250514', 
        object: 'model', created: 1700000000, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: true },
        input: ['text', 'image'],
        max_tokens: 16384
      },
      { 
        id: 'claude-opus-4-20250514', 
        object: 'model', created: 1700000000, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: true },
        input: ['text', 'image'],
        max_tokens: 16384
      },
      { 
        id: 'cluade-sonnet-4-6', 
        object: 'model', created: 1700000000, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: true },
        input: ['text', 'image'],
        max_tokens: 16384
      },
      // 常用别名
      { 
        id: 'claude-3-5-sonnet', 
        object: 'model', created: 1720000000, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: false },
        input: ['text', 'image'],
        max_tokens: 8192
      },
      { 
        id: 'claude-3-7-sonnet', 
        object: 'model', created: 1740000000, owned_by: 'anthropic',
        capabilities: { vision: true, tool_use: true, thinking: true },
        input: ['text', 'image'],
        max_tokens: 16384
      }
    ],

  });
});

// ─── /v1/sf/models — 直接请求硅基模型列表 ★ ──────────────────────────────────
app.get('/v1/sf/models', authenticate, async (req, res) => {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SILICONFLOW_API_KEY not configured' });
  }

  try {
    const sfRes = await fetch('https://api.siliconflow.cn/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!sfRes.ok) {
      return res.status(sfRes.status).json({ error: `SiliconFlow API error: ${sfRes.status}` });
    }
    const data = await sfRes.json();
    res.json(data);
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

  // ★ 话题信息：从路由结果中提取，传给 convertRequest
  const topicOptions = routeDecision?.topic
    ? { topic: routeDecision.topic, topicTags: routeDecision.topicTags }
    : null;

  // ★ 伪多模态处理：如果模型不支持多模态，则自动转换图片或语音为文字
  const hasMultimodalInput = (msgs) => msgs?.some(m => {
    if (!m.content) return false;
    const check = (content) => {
      if (typeof content === 'string') return false;
      if (!Array.isArray(content)) return false;
      return content.some(b => {
        if (['image', 'audio', 'image_url', 'input_audio'].includes(b.type)) return true;
        if (b.type === 'tool_result' && b.content) return check(b.content);
        return false;
      });
    };
    return check(m.content);
  });

  if (!effectiveProvider.multimodal && hasMultimodalInput(body.messages)) {
    log('info', requestId, 'pseudo_multimodal_triggered', { model: originalModel });
    try {
      const processed = await processMultimodalMessages(
        body.messages, 
        VISION_CONFIG, 
        AUDIO_CONFIG,
        (level, sub, msg, data) => log(level, requestId, `${sub}_${msg}`, data),
        controller.signal
      );
      if (processed.isChanged) {
        body.messages = processed.messages;
      }
    } catch (err) {
      log('error', requestId, 'pseudo_multimodal_failed', { error: err.message });
    }
  }

  const converted = convertRequest(body, effectiveProvider, topicOptions);
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
      // ★ 话题追踪日志
      topic_movement: routeDecision.topic?.movement,
      topic_current: routeDecision.topic?.currentTopic
        ? `${routeDecision.topic.currentTopic.domain}/${routeDecision.topic.currentTopic.topic}/${routeDecision.topic.currentTopic.subtopic}`
        : null,
      topic_stack_size: routeDecision.topic?.stack?.length,
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
      2,
      controller.signal
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

    handleStream(backendRes.body, res, originalModel, requestId, provider, startTime, controller.signal)
      .then(metrics => {
        log('info', requestId, 'stream_done', {
          latency_ms: Date.now() - startTime,
          input_tokens: metrics.input, output_tokens: metrics.output,
          thinking_tokens: metrics.thinking,
        });

        recordUsage({
          user_id: user.id, request_id: requestId,
          claude_model: originalModel, backend_model: converted.model,
          input_tokens: metrics.input, output_tokens: metrics.output,
          latency_ms: Date.now() - startTime,
        });

        // 异步记录完整对话，用于回归和观测
        recordConversation(requestId, {
          user_id: user.id,
          request: {
            model: originalModel,
            messages: body.messages,
            tools: body.tools
          },
          response: {
            content: metrics.fullContent,
            usage: { input_tokens: metrics.input, output_tokens: metrics.output }
          },
          latency_ms: Date.now() - startTime
        });
      })
      .catch(err => {
        log('error', requestId, 'handle_stream_failed', { error: err.message });
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

  const provider = getProvider(user.provider || 'nvidia');
  const anthropicMessages = openAIToAnthropicMessages(body.messages || []);

  // ★ 智能路由 (OpenAI 端点也走同样的路由逻辑)
  let routeDecision = null;
  if (provider.isRouter) {
    try {
      routeDecision = await routeRequest(
        anthropicMessages,
        body.tools, // OpenAI tools 格式不同，但 router 现在只看 messages
        originalModel,
        { apiKey: provider.apiKey, endpoint: provider.endpoint },
      );
    } catch (err) {
      log('warn', requestId, 'router_failed', { error: err.message });
    }
  }

  const effectiveProvider = routeDecision
    ? {
        ...provider,
        endpoint: provider.backendEndpoint || provider.endpoint + '/chat/completions',
        modelMap: { default: routeDecision.model },
      }
    : provider;

  // 这里的 hasMultimodalInput 已经统一

  let processedMessages = anthropicMessages;
  if (!effectiveProvider.multimodal && hasMultimodalInput(anthropicMessages)) {
    log('info', requestId, 'pseudo_multimodal_triggered_openai', { model: originalModel });
    try {
      const processed = await processMultimodalMessages(
        anthropicMessages, 
        VISION_CONFIG, 
        AUDIO_CONFIG,
        (level, sub, msg, data) => log(level, requestId, `openai_${sub}_${msg}`, data),
        controller.signal
      );
      if (processed.isChanged) {
        processedMessages = processed.messages;
      }
    } catch (err) {
      log('error', requestId, 'pseudo_multimodal_failed_openai', { error: err.message });
    }
  }

  // 后端大部分都是 OpenAI 协议，这里做一次 convertRequest 主要是为了处理工具定义的映射和模型名映射
  const converted = convertRequest({ ...body, messages: processedMessages }, effectiveProvider);
  
  // 如果已经中止，不再继续
  if (controller.signal.aborted) {
    log('warn', requestId, 'aborted_before_fetch');
    return;
  }
  const startTime = Date.now();

  log('info', requestId, 'request_openai', {
    user: user.username,
    model: originalModel,
    backend: converted.model,
    provider: user.provider,
    stream: isStream,
  });

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
      2, // OpenAI endpoint retry count
      controller.signal
    );
  } catch (err) {
    if (res.writableEnded || res.closed) return;
    log('error', requestId, 'fetch_failed_openai', { error: err.message });
    return res.status(502).json({ error: { message: err.message, type: 'api_error' } });
  }

  if (res.writableEnded || res.closed) {
    log('warn', requestId, 'client_closed_before_response_openai');
    return;
  }

  if (!backendRes.ok) {
    const txt = await backendRes.text().catch(() => '');
    log('error', requestId, 'backend_error_openai', { status: backendRes.status, body: txt.slice(0, 300) });
    return res.status(502).json({ error: { message: `Backend error ${backendRes.status}`, type: 'api_error' } });
  }

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    handleOpenAIStream(backendRes.body, res, requestId, provider, startTime, controller.signal)
      .then(metrics => {
        recordUsage({
          user_id: user.id, request_id: requestId,
          claude_model: originalModel, backend_model: converted.model,
          input_tokens: metrics.input, output_tokens: metrics.output,
          latency_ms: Date.now() - startTime,
        });

        // 异步记录完整对话
        recordConversation(requestId, {
          user_id: user.id,
          request: {
            model: originalModel,
            messages: body.messages,
          },
          response: {
            content: metrics.fullContent,
            usage: { input_tokens: metrics.input, output_tokens: metrics.output }
          },
          latency_ms: Date.now() - startTime
        });
      })
      .catch(err => {
        if (!res.writableEnded && !res.closed) {
          log('error', requestId, 'handle_openai_stream_failed', { error: err.message });
        }
      });
  } else {
    const data = await backendRes.json();
    res.json(data);
    recordUsage({
      user_id: user.id, request_id: requestId,
      claude_model: originalModel, backend_model: converted.model,
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      latency_ms: Date.now() - startTime,
    });
  }
});

// ─── OpenAI 格式流处理 ───────────────────────────────────────────────────────
async function handleOpenAIStream(stream, res, requestId, provider, startTime, signal = null) {
  let inputTokens = 0, outputTokens = 0;
  let fullContent = []; 
  const thinkFilter = provider.stripThinking ? new ThinkingFilter() : null;
  const decoder = new TextDecoder();
  let buffer = '';

  // 内部累加器
  let currentText = '';
  let currentThinking = '';
  const toolAcc = new ToolCallAccumulator();

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        log('warn', requestId, 'stream_aborted_openai');
        break;
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }

        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }

        if (data.usage) {
          inputTokens = data.usage.prompt_tokens;
          outputTokens = data.usage.completion_tokens;
        }

        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        // 积累文本内容
        if (delta.content) {
          currentText += delta.content;
          const filtered = thinkFilter ? thinkFilter.feed(delta.content) : delta.content;
          if (filtered) {
             delta.content = filtered;
          } else {
             delete delta.content;
          }
        }

        // 积累推理内容
        if (delta.reasoning_content) {
          currentThinking += delta.reasoning_content;
        }

        // 积累工具调用
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            toolAcc.accumulate(tc.index, tc);
          }
        }

        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    }
  } catch (err) {

    if (!res.writableEnded && !res.closed) {
      log('error', requestId, 'stream_error_openai', { error: err.message });
    }
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }

  // 组装最终 content
  if (currentThinking) fullContent.push({ type: 'thinking', thinking: currentThinking });
  if (currentText) fullContent.push({ type: 'text', text: currentText });

  const finalTools = toolAcc.getFinalToolCalls();
  for (const tc of finalTools) {
    fullContent.push({
      type: 'tool_use',
      id: tc.id || `call_${randomUUID().slice(0, 8)}`,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}')
    });
  }

  return { input: inputTokens, output: outputTokens, fullContent };
}



// ─── 流式处理 ★ 完整修复版 ───────────────────────────────────────────────────
async function handleStream(stream, res, originalModel, requestId, provider, startTime, signal = null) {
  const msgId = `msg_${requestId.replace(/-/g, '').slice(0, 24)}`;
  let inputTokens = 0, outputTokens = 0;
  let fullContent = []; // 存储完整的 Anthropic content blocks

  const send = (event, data) => {
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
  let textContent = '';

  // Kimi-K2.5 私有格式：工具调用通过 reasoning_content 传出，带特殊标记
  let kimiReasoningBuf = '';   // 积累全部 reasoning_content
  let kimiInToolSection = false; // 是否已进入工具调用区段

  // ★ 全局 block index 计数器，所有 block（text/reasoning/tool）统一分配
  let nextBlockIndex = 0;

  // tool block 映射：OpenAI tool index -> Anthropic block index
  const validToolBlockIndices = new Map();
  
  let stopReason = 'stop';
  let finalOutput = 0;
  let thinkingTokens = 0;

  let chunkCount = 0;
  const pingInterval = setInterval(() => {
    if (chunkCount === 0) {
      send('ping', { type: 'ping' });
    }
  }, 15000);

  try {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      if (signal?.aborted) {
        log('warn', requestId, 'stream_aborted');
        break;
      }
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
          textContent += delta.content;
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

            // ★ 改进：如果推理内容仅仅是单个空格或特定的占位符（如 "NO", "Thinking"），且还没有真正的思考内容，直接忽略
            // 避免在 UI 中产生一个空洞的 "Thinking" 块。只有当内容非占位符时才开启 block。
            const isPlaceholder = [' ', 'Thought process preserved.', 'NO', 'Thinking', 'Thinking...'].includes(text);
            if (isPlaceholder && !thinkingContent) {
              continue;
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
              fullContent.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function?.name || '',
                input: ''
              });
            }

            const blockIdx = validToolBlockIndices.get(idx);
            if (blockIdx !== undefined && tc.function?.arguments) {
              send('content_block_delta', {
                type: 'content_block_delta', index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              });
              // 累积到 fullContent
              const block = fullContent.find(b => b.id === tc.id || (b.type === 'tool_use' && b.name === tc.function.name));
              if (block) {
                block.input = (block.input || '') + tc.function.arguments;
              }
            }
          }
          toolAcc.feed(delta.tool_calls);
        }
      }
    }

  // ── Kimi 私有格式工具调用解析 ────────────────────────────────────────────
  // 仅在明确是 Kimi 模型时才处理
  const isKimi = originalModel.toLowerCase().includes('kimi');
  if (isKimi && kimiInToolSection && kimiReasoningBuf.includes('<|tool_calls_section_begin|>')) {
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
  } // 结束 for await (const chunk of stream)

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
    stopReason = hasToolCalls ? 'tool_use' : mapStopReason(finishReason, false);

    finalOutput = usageFromChunk?.completion_tokens || outputTokens;
    inputTokens = usageFromChunk?.prompt_tokens || 0;

    thinkingTokens = thinkFilter
      ? Math.ceil(thinkFilter.getThinking().length / 4)
      : Math.ceil(thinkingContent.length / 4);

    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: finalOutput },
    });
    send('message_stop', { type: 'message_stop' });
  } catch (err) {
    if (!res.writableEnded && !res.closed) {
      log('error', requestId, 'stream_error', { error: err.message });
    }
  } finally {
    clearInterval(pingInterval);
    if (!res.writableEnded && !res.closed) {
      res.end();
    }
  }
    if (thinkingContent) fullContent.push({ type: 'thinking', thinking: thinkingContent });
    if (textContent)     fullContent.push({ type: 'text', text: textContent });
    
    // 工具调用：从 toolAcc 中获取解析后的结果
    const finalTools = toolAcc.getCompleted();
    for (const tc of finalTools) {
      fullContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}')
      });
    }

    return { input: inputTokens, output: finalOutput, thinking: thinkingTokens, fullContent };
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
