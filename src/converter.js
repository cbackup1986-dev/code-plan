/**
 * converter.js — Anthropic <-> OpenAI 格式转换
 *
 * 核心功能:
 * 1. stop_reason 精确映射
 * 2. 流式 tool arguments 分片积累
 * 3. tool_result / tool_use 消息双向转换
 * 4. observation 注入（tool result 后插入推理提示）
 * 5. <think> 块过滤（R1 推理内容不透传给 Claude Code）
 * 6. JSON 自动修复
 */
import { mapModel, getToolPrefix, OBSERVATION_PROMPT } from './providers.js';
import { compressMessages } from './context.js';

// ─── Anthropic → OpenAI ────────────────────────────────────────────────────
export function convertRequest(anthropicBody, provider) {
  const messages = [];
  const prefix = getToolPrefix(provider);

  // System prompt + CoT 前缀
  if (anthropicBody.system) {
    const text = typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : anthropicBody.system.map(b => b.text || '').join('\n');
    messages.push({ role: 'system', content: prefix + text });
  } else if (prefix) {
    messages.push({ role: 'system', content: prefix });
  }

  // 转换每条消息
  // ★ 修复：Kimi/SiliconFlow 不需要 reasoning_content 占位符，反而会触发退化
  // 只有明确声明 requiresReasoningPlaceholder 的 provider 才注入
  const requiresReasoningPlaceholder = !!provider.requiresReasoningPlaceholder;
  for (const msg of (anthropicBody.messages || [])) {
    const converted = convertMessage(msg, requiresReasoningPlaceholder);
    if (Array.isArray(converted)) messages.push(...converted);
    else if (converted) messages.push(converted);
  }

  // ★ 观察后推理注入：在最后一条 tool result 后插入推理提示
  if (provider.injectObservation) {
    injectObservationIfNeeded(messages);
  }

  // 上下文压缩
  const maxTokens = provider.maxContextTokens || 60000;
  const compressed = compressMessages(messages, maxTokens);

  // Tools
  const tools = anthropicBody.tools?.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  const toolChoice = anthropicBody.tool_choice
    ? convertToolChoice(anthropicBody.tool_choice)
    : (tools?.length ? 'auto' : undefined);

  return {
    model:      mapModel(provider, anthropicBody.model || 'claude-sonnet-4-20250514'),
    messages:   compressed,
    max_tokens: anthropicBody.max_tokens || 8096,
    temperature: anthropicBody.temperature ?? 0.7,
    stream:     anthropicBody.stream ?? false,
    ...(tools?.length ? { tools, tool_choice: toolChoice } : {}),
  };
}

// ★ 观察后推理注入
// 在最后一条 tool 消息后插入一条 user 提示，强迫模型评估结果再继续
function injectObservationIfNeeded(messages) {
  // 找到最后一条 tool 消息的位置
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') { lastToolIdx = i; break; }
  }

  // 只在 tool result 是最后一条消息时注入（即模型即将回复的时机）
  if (lastToolIdx === messages.length - 1) {
    messages.push({ role: 'user', content: OBSERVATION_PROMPT });
  }
}

function convertMessage(msg, requiresReasoningPlaceholder = false) {
  const { role, content } = msg;
  if (typeof content === 'string') return { role, content };
  if (!Array.isArray(content)) return { role, content: String(content) };

  // 提取推理内容（如果有）
  let reasoningStr = '';
  const reasoningBlocks = content.filter(b => b.type === 'reasoning_content' || b.type === 'thinking');
  if (reasoningBlocks.length > 0) {
    reasoningStr = reasoningBlocks.map(b => {
      if (b.type === 'thinking') return b.thinking || '';
      if (b.type === 'reasoning_content') {
        return (typeof b.reasoning_content === 'object') ? (b.reasoning_content.thinking || '') : String(b.reasoning_content);
      }
      return '';
    }).join('\n').trim();
  }

  // tool_result → OpenAI tool role
  const toolResults = content.filter(b => b.type === 'tool_result');
  if (toolResults.length > 0) {
    const msgs = toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content: extractText(tr.content),
    }));

    const textBlocks = content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      const textStr = textBlocks.map(b => b.text).join('\n').trim();
      if (textStr) {
        // OpenAI expects the follow-up text from user to be a separate user message.
        msgs.push({ role: 'user', content: textStr });
      }
    }
    return msgs;
  }

  // assistant with tool_use
  const toolUses = content.filter(b => b.type === 'tool_use');
  const textBlocks = content.filter(b => b.type === 'text');
  if (toolUses.length > 0) {
    return {
      role: 'assistant',
      content: textBlocks.map(b => b.text).join('') || null,
      // 修复 Kimi-K2.5 400 错误：如果历史中缺失推理内容，必须注入占位符
      // ★ 修复：只在 provider 明确需要时才注入占位符
      //   Kimi-K2.5 收到 "Thought process preserved." 后会退化成只输出 thinking
      ...(requiresReasoningPlaceholder && !reasoningStr
        ? { reasoning_content: 'Thought process preserved.' }
        : reasoningStr
          ? { reasoning_content: reasoningStr }
          : {}
      ),
      tool_calls: toolUses.map((tu, i) => ({
        id: tu.id || `call_${i}_${Date.now()}`,
        type: 'function',
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      })),
    };
  }

  // Multimodal
  if (content.some(b => b.type === 'image')) {
    return {
      role,
      content: content.map(b => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image') {
          const url = b.source?.type === 'base64'
            ? `data:${b.source.media_type};base64,${b.source.data}`
            : b.source?.url || '';
          return { type: 'image_url', image_url: { url } };
        }
        return null;
      }).filter(Boolean),
    };
  }

  const textStr = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { 
    role, 
    content: textStr || null,
    ...(reasoningStr ? { reasoning_content: reasoningStr } : {})
  };
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return String(content);
}

function convertToolChoice(tc) {
  if (!tc) return 'auto';
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any')  return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  return 'auto';
}

// ─── OpenAI → Anthropic (非流式) ──────────────────────────────────────────
export function convertResponse(openaiResp, originalModel, requestId, provider) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return errorResponse(requestId, originalModel, 'No choices in response');
  }

  const message = choice.message || {};
  const content = [];

  // ★ 过滤 <think> 块（R1 推理内容不透传）
  let textContent = message.content || '';
  if (provider?.stripThinking) {
    textContent = stripThinkingBlocks(textContent);
  }

  // ★ 提取推理内容
  if (message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content
    });
  }

  if (textContent) {
    content.push({ type: 'text', text: textContent });
  }

  let hasValidToolCalls = false;
  // Tool calls
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      if (tc.function?.name === 'think') continue; 
      hasValidToolCalls = true;
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {
        try { input = JSON.parse(repairJSON(tc.function?.arguments || '{}')); } catch { input = {}; }
      }
      content.push({
        type: 'tool_use',
        id: tc.id || `toolu_${requestId.replace(/-/g,'').slice(0,24)}`,
        name: tc.function?.name || 'unknown',
        input,
      });
    }
  }

  const stopReason = mapStopReason(choice.finish_reason, hasValidToolCalls);

  return {
    id: `msg_${requestId}`,
    type: 'message', role: 'assistant', model: originalModel,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: stopReason, stop_sequence: null,
    usage: {
      input_tokens:  openaiResp.usage?.prompt_tokens     || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

// ─── stop_reason 映射 ──────────────────────────────────────────────────────
export function mapStopReason(finishReason, hasToolCalls = false) {
  if (finishReason === 'tool_calls' || hasToolCalls) return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}

// ─── ToolCallAccumulator：流式分片拼接 ────────────────────────────────────
export class ToolCallAccumulator {
  constructor() { this.calls = {}; }

  feed(toolCallDelta) {
    for (const tc of toolCallDelta) {
      const i = tc.index ?? 0;
      if (!this.calls[i]) this.calls[i] = { id: '', name: '', arguments: '' };
      if (tc.id) this.calls[i].id = tc.id;
      if (tc.function?.name) this.calls[i].name += tc.function.name;
      if (tc.function?.arguments) this.calls[i].arguments += tc.function.arguments;
    }
  }

  getCompleted() { return Object.values(this.calls); }
}

// ★ ThinkingFilter：流式过滤 <think>...</think>（用于 R1） ─────────────────
export class ThinkingFilter {
  constructor() {
    this.inThink = false;
    this.thinking = '';   // 积累思考内容（可记日志）
    this.buf = '';        // 跨 chunk 的不完整标签缓冲
  }

  // 输入一段文本，返回去掉 <think>...</think> 后的内容
  feed(text) {
    let input = this.buf + text;
    this.buf = '';
    let output = '';

    while (input.length > 0) {
      if (!this.inThink) {
        const start = input.indexOf('<think>');
        if (start === -1) {
          // 检查末尾是否是 <think> 的部分前缀（跨 chunk）
          const partial = partialSuffix(input, '<think>');
          if (partial > 0) {
            output += input.slice(0, input.length - partial);
            this.buf = input.slice(input.length - partial);
          } else {
            output += input;
          }
          break;
        }
        output += input.slice(0, start);
        input = input.slice(start + 7);
        this.inThink = true;
      } else {
        const end = input.indexOf('</think>');
        if (end === -1) {
          this.thinking += input;
          break;
        }
        this.thinking += input.slice(0, end);
        input = input.slice(end + 8);
        this.inThink = false;
      }
    }

    return output;
  }

  getThinking() { return this.thinking; }
}

// 返回 text 末尾有多少个字符是 target 的前缀
function partialSuffix(text, target) {
  for (let len = Math.min(target.length - 1, text.length); len > 0; len--) {
    if (target.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

// ─── JSON 修复 ─────────────────────────────────────────────────────────────
export function repairJSON(str) {
  if (!str || typeof str !== 'string') return '{}';
  let s = str.trim();
  s = s.replace(/'/g, '"');
  s = s.replace(/,\s*([}\]])/g, '$1');

  const opens = [];
  let inStr = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') opens.push('}');
    else if (ch === '[') opens.push(']');
    else if (ch === '}' || ch === ']') opens.pop();
  }
  if (inStr) s += '"';
  s += opens.reverse().join('');
  return s;
}

// ─── <think> 块剥离（非流式） ─────────────────────────────────────────────
export function stripThinkingBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function errorResponse(requestId, model, message) {
  return {
    id: `msg_${requestId}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: message }],
    stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 },
  };
}
