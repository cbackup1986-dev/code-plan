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
 *
 * ★ 话题感知压缩:
 *   - shift: 更激进地压缩前一个话题的消息
 *   - return: 保留目标话题的消息，压缩中间插入的话题
 *   - consistent: 正常压缩
 *
 * @param {Array} messages — 消息列表
 * @param {number} maxTokens — 最大 token 数
 * @param {object} topicInfo — 话题检测结果 { currentTopic, movement, returnTarget, stack }
 * @param {Array} topicTags — 每条消息的话题标签 [{ role, topicKey }]
 */
export function compressMessages(messages, maxTokens = 60000, topicInfo = null, topicTags = null) {
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

  // ★ 话题感知：确定哪些消息属于 "冷" 话题（可以更激进地压缩）
  const coldTopicKeys = new Set();
  let returnTopicKey = null;

  if (topicInfo && topicTags) {
    const currentKey = topicInfo.currentTopic
      ? `${topicInfo.currentTopic.domain}/${topicInfo.currentTopic.topic}/${topicInfo.currentTopic.subtopic}`
      : null;

    if (topicInfo.movement === 'shift' && topicInfo.stack?.length >= 2) {
      // shift: 上一个话题变成 "冷" 话题
      for (const entry of topicInfo.stack.slice(1)) {
        coldTopicKeys.add(entry.key);
      }
    } else if (topicInfo.movement === 'return' && topicInfo.returnTarget) {
      // return: 中间插入的话题变成 "冷" 话题
      returnTopicKey = `${topicInfo.returnTarget.domain}/${topicInfo.returnTarget.topic}/${topicInfo.returnTarget.subtopic}`;
      for (const entry of topicInfo.stack) {
        if (entry.key !== returnTopicKey && entry.key !== currentKey) {
          coldTopicKeys.add(entry.key);
        }
      }
    }
  }

  // Compress middle: summarize tool results, truncate large file reads
  // ★ 话题感知：冷话题压缩阈值更低
  const compressed = middle.map((m, i) => {
    // 获取该消息对应的话题 tag（跳过 system 消息的偏移）
    const tagIndex = i + 1; // +1 因为 head 占了 index 0
    const tag = topicTags?.[systemMsgs.length + tagIndex];
    const isColdTopic = tag && coldTopicKeys.has(tag.topicKey);
    const isReturnTopic = tag && tag.topicKey === returnTopicKey;

    // 冷话题：更低的截断阈值 + 额外摘要
    const truncateThreshold = isColdTopic ? 100 : 500;
    const truncateLength = isColdTopic ? 300 : 1000;

    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const tokens = estimateTokens(content);
      if (tokens > truncateThreshold) {
        const suffix = isColdTopic
          ? '\n... [非当前话题内容已压缩] ...'
          : '\n... [内容已截断以节省上下文] ...';
        return { ...m, content: content.slice(0, truncateLength) + suffix };
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      // Compress large tool_use input
      const inputThreshold = isColdTopic ? 300 : 1000;
      const compressed_content = m.content.map(block => {
        if (block.type === 'tool_use') {
          const inputStr = JSON.stringify(block.input || {});
          if (inputStr.length > inputThreshold) {
            return { ...block, input: { _truncated: true, preview: inputStr.slice(0, 200) } };
          }
        }
        return block;
      });
      return { ...m, content: compressed_content };
    }

    // ★ 冷话题的 user/assistant 文本消息也做压缩
    if (isColdTopic && !isReturnTopic && typeof m.content === 'string') {
      const tokens = estimateTokens(m.content);
      if (tokens > 200) {
        return { ...m, content: m.content.slice(0, 400) + '\n... [非当前话题内容已压缩] ...' };
      }
    }

    return m;
  });

  // Inject context summary only when we actually truncated content
  const didTruncate = compressed.some((m, i) =>
    m.content !== middle[i]?.content && typeof m.content === 'string' && m.content.includes('已截断')
  );

  // ★ 话题感知摘要
  let summaryText = `[系统提示：以上 ${middle.length} 条历史消息已被压缩以节省上下文窗口。`;
  if (topicInfo?.movement === 'shift') {
    summaryText += `检测到话题切换，前一话题的内容已被更多压缩。`;
  } else if (topicInfo?.movement === 'return') {
    const retKey = returnTopicKey || '之前的话题';
    summaryText += `检测到话题回归（${retKey}），相关上下文已优先保留。`;
  }
  summaryText += `请继续当前任务。]`;

  const summary = didTruncate ? [{
    role: 'user',
    content: summaryText,
  }, {
    role: 'assistant',
    content: '我理解，我会基于最近的上下文继续完成任务。',
  }] : [];

  const result = [...systemMsgs, ...head, ...summary, ...compressed, ...tail];
  const newEstimate = estimateMessagesTokens(result);
  console.log(`[context] Compressed to ~${newEstimate} tokens (movement: ${topicInfo?.movement || 'unknown'})`);
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
