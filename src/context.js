/**
 * context.js — 上下文窗口管理
 *
 * 修复: 长对话后国产模型注意力衰减、忘记早期约束的问题
 *
 * 策略:
 * 1. token 估算（简单字符计数，无需 tokenizer 库）
 * 2. 超过阈值时，压缩中间的 tool_result 消息（保留首尾）
 * 3. 注入"上下文摘要"消息，让模型知道哪些文件已被读取
 */

// 粗略估算 token 数 (英文约4字符/token，中文约1.5字符/token)
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    total += estimateTokens(content) + 4; // role overhead
  }
  return total;
}

/**
 * 压缩消息历史，保持在 maxTokens 以内
 *
 * 策略: 优先裁剪中间的 tool 结果消息（通常最长且信息密度最低）
 * 始终保留: system, 最近N轮消息, 首条 user 消息
 */
export function compressMessages(messages, maxTokens = 60000) {
  const estimated = estimateMessagesTokens(messages);
  if (estimated <= maxTokens) return messages;

  console.log(`[context] Compressing: ${estimated} → target ${maxTokens} tokens`);

  // Separate system message
  const systemMsgs = messages.filter(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');

  // Always keep last 20 messages (10 turns) intact
  const KEEP_TAIL = 20;
  const tail = chatMsgs.slice(-KEEP_TAIL);
  const head = chatMsgs.slice(0, 1); // first user message for context
  const middle = chatMsgs.slice(1, -KEEP_TAIL);

  // Compress middle: summarize tool results, truncate large file reads
  const compressed = middle.map(m => {
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const tokens = estimateTokens(content);
      if (tokens > 500) {
        // Truncate to first 500 tokens worth of content (~2000 chars)
        return { ...m, content: content.slice(0, 1000) + '\n... [内容已截断以节省上下文] ...' };
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // Compress large tool_use input
      const compressed_content = m.content.map(block => {
        if (block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input || {});
          if (inputStr.length > 1000) {
            return { ...block, input: { _truncated: true, preview: inputStr.slice(0, 200) } };
          }
        }
        return block;
      });
      return { ...m, content: compressed_content };
    }
    return m;
  });

  // Inject context summary only when we actually truncated content
  const didTruncate = compressed.some((m, i) =>
    m.content !== middle[i]?.content && typeof m.content === 'string' && m.content.includes('内容已截断')
  );
  const summary = didTruncate ? [{
    role: 'user',
    content: `[系统提示：以上 ${middle.length} 条历史消息已被压缩以节省上下文窗口。请继续当前任务。]`,
  }, {
    role: 'assistant',
    content: '我理解，我会基于最近的上下文继续完成任务。',
  }] : [];

  const result = [...systemMsgs, ...head, ...summary, ...compressed, ...tail];
  const newEstimate = estimateMessagesTokens(result);
  console.log(`[context] Compressed to ~${newEstimate} tokens`);
  return result;
}

/**
 * 提取对话中已读取的文件列表（用于上下文感知）
 */
export function extractReadFiles(messages) {
  const files = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'tool_use' && block.name === 'Read' && block.input?.file_path) {
          files.add(block.input.file_path);
        }
      }
    }
  }
  return [...files];
}
