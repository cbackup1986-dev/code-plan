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
import { compressMessages, estimateMessagesTokens } from './context.js';

/**
 * 将 OpenAI 格式的消息转换为 Anthropic 格式
 */
export function openAIToAnthropicMessages(openaiMessages) {
  return openaiMessages.map(msg => {
    const { role, content, name, tool_calls, tool_call_id } = msg;

    // 处理工具回复 (OpenAI role: tool)
    if (role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: tool_call_id,
            content: content
          }
        ]
      };
    }

    // 处理助手消息 (可能带工具调用)
    if (role === 'assistant' && tool_calls) {
      const blocks = [];
      if (content) blocks.push({ type: 'text', text: content });
      
      tool_calls.forEach(tc => {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        });
      });
      return { role: 'assistant', content: blocks };
    }

    // 处理普通内容
    if (typeof content === 'string') {
      return { role, content };
    }

    if (Array.isArray(content)) {
      const blocks = content.map(b => {
        if (typeof b === 'string') return { type: 'text', text: b };
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'image_url') {
          const url = b.image_url?.url || '';
          if (url.startsWith('data:')) {
            const match = url.match(/^data:(image\/\w+);base64,(.*)$/);
            if (match) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: match[1],
                  data: match[2]
                }
              };
            }
          }
          return { type: 'image', source: { type: 'url', url } };
        }
        if (b.type === 'image' || b.type === 'audio' || b.type === 'input_audio') return b;
        return b;
      });
      return { role, content: blocks };
    }

    return { role, content: String(content || '') };
  });
}

// ─── Anthropic → OpenAI ────────────────────────────────────────────────────
export function convertRequest(anthropicBody, provider, topicOptions = null) {
  const messages = [];
  const prefix = getToolPrefix(provider);

  // ★ 发掘最终使用的模型名称
  const mappedModel = mapModel(provider, anthropicBody.model || 'claude-sonnet-4-20250514');
  const modelNameLower = mappedModel.toLowerCase();

  // ★ 兼容 9B 等小模型：对它们启用系统提示词蒸馏
  const isSmallModel = topicOptions?.isSmallModel ?? 
    (/\b([1-9]|1[0-4])b\b/.test(modelNameLower) || modelNameLower.includes('mini') || modelNameLower.includes('haiku'));

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

  // ★ 上下文压缩（话题感知与小模型蒸馏）
  const maxTokens = provider.maxContextTokens || 60000;
  const topicInfo = topicOptions?.topic || null;
  const topicTags = topicOptions?.topicTags || null;
  const compressed = compressMessages(messages, maxTokens, topicInfo, topicTags, isSmallModel);

  // ★ 获取负载和强制路由开关状态 (如果 isRouter=false 则 topicOptions 为空，需自动计算)
  const disableSmartRouting = topicOptions?.disableSmartRouting ?? !!provider.disableSmartRouting;
  let isHeavyContext = topicOptions?.isHeavyContext;
  if (isHeavyContext === undefined) {
    const totalTokens = estimateMessagesTokens(messages);
    isHeavyContext = totalTokens > 25000;
  }

  // ★ 极限测试警告注入
  if (disableSmartRouting && isHeavyContext) {
    compressed.push({
      role: 'user',
      content: '[系统要求：当前请求上下文极大，由于禁用了智能路由，你正在极限条件下运行。请在回答的最开头强制输出：“[Proxy提示：当前上下文超长，已使用小模型强行处理]”，然后再继续回答用户的提问或调用工具。]'
    });
  }

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
    model:      mappedModel,
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

  // 提取推理内容（具有原生 thinking 类型优先）
  let reasoningStr = '';
  const reasoningBlocks = content.filter(b => b.type === 'reasoning_content' || b.type === 'thinking');
  if (reasoningBlocks.length > 0) {
    reasoningStr = reasoningBlocks.map(b => {
      if (b.type === 'thinking') return b.thinking || '';
      if (b.type === 'reasoning_content') {
        const rc = b.reasoning_content;
        return (typeof rc === 'object') ? (rc.thinking || '') : String(rc);
      }
      return '';
    }).join('\n').trim();
  }

  // ★ 历史记录清洗：将旧的占位符映射到新的 " "
  // 避免 Kimi-K2.5 看到历史中的旧占位符后出现死循环、退化或重复输出
  const placeholders = [' ', 'Thought process preserved.', 'NO', 'Thinking', 'Thinking...'];
  if (placeholders.includes(reasoningStr)) {
    reasoningStr = ' ';
  }

  // ★ 兼容性增强：如果原生字段缺失，尝试从 text blocks 中提取 <think> 标签
  const textBlocks = content.filter(b => b.type === 'text');
  if (!reasoningStr && textBlocks.length > 0) {
    for (const b of textBlocks) {
      const match = b.text.match(/<think>([\s\S]*?)<\/think>/);
      if (match) {
        reasoningStr = match[1].trim();
        // 从原文中剥离 <think> 块，避免重复发送
        b.text = b.text.replace(/<think>[\s\S]*?<\/think>/, '').trim();
        break;
      }
    }
  }

  // tool_result → OpenAI tool role
  const toolResults = content.filter(b => b.type === 'tool_result');
  if (toolResults.length > 0) {
    const msgs = toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content: extractText(tr.content),
    }));

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
  if (toolUses.length > 0) {
    return {
      role: 'assistant',
      content: textBlocks.map(b => b.text).join('') || null,
      // 修复 Kimi-K2.5 400 错误：如果历史中缺失推理内容，必须注入占位符
      // ★ 修复：只在 provider 明确需要时才注入占位符
      //   注意：Kimi-K2.5 若收到 "Thought process preserved." 会退化成只输出 thinking，故改为空格
      ...(requiresReasoningPlaceholder && !reasoningStr
        ? { reasoning_content: ' ' }
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
    ...(requiresReasoningPlaceholder && !reasoningStr
      ? { reasoning_content: ' ' }
      : reasoningStr
        ? { reasoning_content: reasoningStr }
        : {}
    ),
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
  const rContent = message.reasoning_content;
  const isPlaceholder = [' ', 'Thought process preserved.', 'NO', 'Thinking', 'Thinking...'].includes(rContent);
  if (rContent && !isPlaceholder) {
    content.push({
      type: 'thinking',
      thinking: rContent
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
    this.currentEndTag = '</think>';
  }

  // 输入一段文本，返回去掉 <think>...</think> 或 <thought>...</thought> 后的内容
  feed(text) {
    let input = this.buf + text;
    this.buf = '';
    let output = '';

    while (input.length > 0) {
      if (!this.inThink) {
        // 同时查找两种可能的开始标签
        const thinkStart = input.indexOf('<think>');
        const thoughtStart = input.indexOf('<thought>');
        
        let start = -1;
        let tagLen = 7;
        let endTag = '</think>';

        if (thinkStart !== -1 && (thoughtStart === -1 || thinkStart < thoughtStart)) {
          start = thinkStart;
          tagLen = 7;
          endTag = '</think>';
        } else if (thoughtStart !== -1) {
          start = thoughtStart;
          tagLen = 9;
          endTag = '</thought>';
        }

        if (start === -1) {
          // 检查末尾是否是标签的部分前缀
          const p1 = partialSuffix(input, '<think>');
          const p2 = partialSuffix(input, '<thought>');
          const partial = Math.max(p1, p2);
          if (partial > 0) {
            output += input.slice(0, input.length - partial);
            this.buf = input.slice(input.length - partial);
          } else {
            output += input;
          }
          break;
        }
        
        output += input.slice(0, start);
        input = input.slice(start + tagLen);
        this.inThink = true;
        this.currentEndTag = endTag;
      } else {
        const end = input.indexOf(this.currentEndTag);
        if (end === -1) {
          this.thinking += input;
          break;
        }
        this.thinking += input.slice(0, end);
        input = input.slice(end + this.currentEndTag.length);
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

// ─── <think>/<thought> 块剥离（非流式） ───────────────────────────────────
export function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/<thought>[\s\S]*?<\/thought>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function errorResponse(requestId, model, message) {
  return {
    id: `msg_${requestId}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: message }],
    stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 },
  };
}
