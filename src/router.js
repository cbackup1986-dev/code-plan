/**
 * router.js — 意图识别 + 智能模型路由
 *
 * 流程:
 * 1. 用快速小模型（Qwen-7B）分析请求意图，耗时 < 500ms
 * 2. 根据意图 + 上下文特征，选择最合适的后端模型
 * 3. 将路由结果注入 provider，走正常转发流程
 *
 * 意图分类:
 *   simple_qa      → 简单问答、解释、翻译        → Qwen2.5-7B（极速）
 *   code_gen       → 代码生成、补全、调试         → Kimi-K2.5（代码最强）
 *   code_edit      → 文件级代码修改、重构         → Kimi-K2.5
 *   deep_reasoning → 复杂推理、架构设计、长规划    → DeepSeek-V3.2（推理更强）
 *   file_ops       → 文件读写、工具调用密集型      → Kimi-K2.5（工具调用稳定）
 *   long_context   → 超长上下文处理               → DeepSeek-V3.2（长窗口）
 */

import fetch from 'node-fetch';
import { TopicTracker, buildTopicClassifierPrompt } from './topic.js';

// ─── 路由目标定义 ──────────────────────────────────────────────────────────
export const ROUTE_TARGETS = {
  simple_qa: {
    label: '简单问答',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    reason: '快速轻量，适合问答/解释/翻译',
  },
  code_gen: {
    label: '代码生成',
    model: 'Pro/moonshotai/Kimi-K2.5',
    reason: '工具调用稳定，代码结构优秀',
  },
  code_edit: {
    label: '代码编辑',
    model: 'Pro/moonshotai/Kimi-K2.5',
    reason: '文件级修改，工具调用密集',
  },
  deep_reasoning: {
    label: '深度推理',
    model: 'deepseek-ai/DeepSeek-V3.2',
    reason: '复杂推理、架构决策首选',
  },
  file_ops: {
    label: '文件操作',
    model: 'Pro/moonshotai/Kimi-K2.5',
    reason: '多轮工具调用，Kimi 最稳定',
  },
  long_context: {
    label: '长上下文',
    model: 'deepseek-ai/DeepSeek-V3.2',
    reason: '超长上下文，DeepSeek 窗口更稳',
  },
};

// ─── 快速规则预判（不消耗 API，< 1ms）────────────────────────────────────
function quickHeuristic(messages, tools, totalTokens) {
  // 超长上下文直接路由
  if (totalTokens > 40000) return 'long_context';

  // 有工具定义且消息多 → 文件操作型
  if (tools?.length > 0 && messages.length > 6) return 'file_ops';

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const text = (typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : JSON.stringify(lastUserMsg?.content || '')
  ).toLowerCase();

  // 代码关键词
  const codeEditKw = ['修改', '重构', 'refactor', 'edit', 'fix', 'bug', '替换', 'replace', '删除'];
  const codeGenKw  = ['写一个', '实现', 'implement', 'create', 'generate', '生成', '函数', 'function', 'class', '组件'];
  const reasonKw   = ['为什么', '分析', '设计', '架构', 'architecture', 'design', '方案', '比较', 'tradeoff', '权衡'];
  const simpleKw   = ['什么是', '解释', 'explain', '翻译', 'translate', '总结', 'summarize'];

  if (codeEditKw.some(k => text.includes(k))) return 'code_edit';
  if (codeGenKw.some(k => text.includes(k)))  return 'code_gen';
  if (reasonKw.some(k => text.includes(k)))   return 'deep_reasoning';
  if (simpleKw.some(k => text.includes(k)))   return 'simple_qa';

  // 消息短 + 无工具 → 简单问答
  if (text.length < 200 && !tools?.length) return 'simple_qa';

  return null; // 需要 LLM 判断
}

// ─── LLM 意图识别（快速小模型）────────────────────────────────────────────
async function llmClassify(messages, tools, apiKey, endpoint, topicSummary = null) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const text = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : JSON.stringify(lastUserMsg?.content || '');

  // ★ 话题上下文注入
  let topicContext = '';
  if (topicSummary) {
    topicContext = `\n\n话题上下文:\n- 最近话题: ${topicSummary.recent_topics.join(', ') || '无'}\n- 可能回归的话题: ${topicSummary.candidate_return_topics.join(', ') || '无'}`;
  }

  const systemPrompt = `你是一个请求分类器。根据用户消息，输出以下分类之一，只输出分类名，不要解释：
simple_qa / code_gen / code_edit / deep_reasoning / file_ops / long_context

分类规则：
- simple_qa: 简单问答、解释概念、翻译、总结
- code_gen: 生成新代码、实现功能、写函数/类/组件
- code_edit: 修改已有代码、重构、修bug、替换内容
- deep_reasoning: 复杂推理、系统设计、架构分析、技术方案对比
- file_ops: 涉及文件读写/创建/删除等操作，或多步骤工具调用
- long_context: 需要处理大量文本/代码

有工具定义: ${tools?.length > 0 ? '是' : '否'}${topicContext}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000); // 3s 超时

    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen2.5-7B-Instruct',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text.slice(0, 500) }, // 只取前500字符
        ],
        max_tokens: 20,
        temperature: 0,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json();
    const intent = data.choices?.[0]?.message?.content?.trim().toLowerCase();
    return ROUTE_TARGETS[intent] ? intent : null;
  } catch {
    return null; // 超时或失败，降级到规则
  }
}

// ─── 估算 token 数 ─────────────────────────────────────────────────────────
function estimateTokens(messages) {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(text.length / 3);
  }, 0);
}

// ─── 主路由函数 ────────────────────────────────────────────────────────────
export async function routeRequest(messages, tools, claudeModel, routerConfig) {
  const totalTokens = estimateTokens(messages);
  const startTs = Date.now();

  // ★ 话题追踪：从消息历史中重建话题状态
  const tracker = new TopicTracker(messages);
  const topicResult = tracker.getResult();
  const topicSummary = tracker.getTopicSummary();

  // 1. 快速规则预判
  let intent = quickHeuristic(messages, tools, totalTokens);
  let method = 'heuristic';

  // 2. 规则未命中，调用小模型分类（★ 带话题上下文）
  if (!intent) {
    intent = await llmClassify(
      messages,
      tools,
      routerConfig.apiKey,
      routerConfig.endpoint,
      topicSummary,
    );
    method = intent ? 'llm' : 'fallback';
  }

  // 3. 兜底：Kimi（综合最佳）
  if (!intent || !ROUTE_TARGETS[intent]) {
    intent = 'code_gen';
    method = 'fallback';
  }

  const target = ROUTE_TARGETS[intent];
  const latency = Date.now() - startTs;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: 'router_decision',
    intent,
    model: target.model,
    method,
    totalTokens,
    latency_ms: latency,
    reason: target.reason,
    // ★ 话题追踪日志
    topic: topicResult.currentTopic,
    topic_movement: topicResult.movement,
    topic_return_target: topicResult.returnTarget,
    topic_stack_size: topicResult.stack.length,
  }));

  return {
    intent,
    model: target.model,
    label: target.label,
    reason: target.reason,
    method,
    latency_ms: latency,
    // ★ 话题信息
    topic: topicResult,
    topicTags: tracker.getMessageTopicTags(),
  };
}
