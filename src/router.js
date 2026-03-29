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

const IS_OFFLINE = process.env.OFFLINE === 'true';

// ─── 阈值定义 ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT_MAX_SMALL = 10000;  // 系统提示词超过此长度，升级到强模型
const TOTAL_TOKENS_MAX_SMALL = 25000;   // 总 Token 超过此长度，升级到强模型

// ─── 路由目标定义 ──────────────────────────────────────────────────────────
export const ROUTE_TARGETS = IS_OFFLINE ? {
  simple_qa: {
    label: '本地问答',
    model: process.env.LOCAL_QA_MODEL || 'qwen2.5:7b',
    reason: '本地模型，适合通用问答',
  },
  code_gen: {
    label: '本地代码生成',
    model: process.env.LOCAL_CODE_MODEL || 'qwen2.5-coder:7b',
    reason: '本地代码模型，支持补全和实现',
  },
  code_edit: {
    label: '本地代码编辑',
    model: process.env.LOCAL_CODE_MODEL || 'qwen2.5-coder:7b',
    reason: '本地代码模型，文件级读取与修改',
  },
  deep_reasoning: {
    label: '本地推理',
    model: process.env.LOCAL_REASON_MODEL || 'llama3.1:8b',
    reason: '本地逻辑解析',
  },
  file_ops: {
    label: '本地操作',
    model: process.env.LOCAL_CODE_MODEL || 'qwen2.5-coder:7b',
    reason: '本地代码模型工具调用',
  },
  long_context: {
    label: '本地长文本',
    model: process.env.LOCAL_CODE_MODEL || 'qwen2.5-coder:7b',
    reason: '本地长窗口',
  },
} : {
  simple_qa: {
    label: '简单问答',
    model: 'Qwen/Qwen3.5-9B',
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
function quickHeuristic(messages, tools, totalTokens, disableSmartRouting = false) {
  // 1. 获取系统提示词长度
  const systemMsg = messages.find(m => m.role === 'system');
  const systemPromptLen = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content.length : JSON.stringify(systemMsg.content).length) : 0;
  const systemPromptTokens = Math.ceil(systemPromptLen / 3);

  // 2. 超长上下文或大系统提示词直接路由到强模型
  if (!disableSmartRouting && (totalTokens > 40000 || systemPromptTokens > 20000)) return 'long_context';
  
  // 3. 针对 7B/9B 模型的高负载预警（虽然还没到 40k，但已经开始吃力的区间）
  const isHeavyContext = totalTokens > TOTAL_TOKENS_MAX_SMALL || systemPromptTokens > SYSTEM_PROMPT_MAX_SMALL;

  // 有工具定义且消息多 → 文件操作型
  if (tools?.length > 0 && messages.length > 5) return 'file_ops';

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const text = (typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : JSON.stringify(lastUserMsg?.content || '')
  ).toLowerCase();

  // 代码及操作关键词
  const codeEditKw = ['修改', '重构', 'refactor', 'edit', 'fix', 'bug', '替换', 'replace', '删除', '改写', '优化'];
  const codeGenKw = ['写一个', '实现', 'implement', 'create', 'generate', '生成', '函数', 'function', 'class', '组件', '示例'];
  const reasonKw = ['为什么', '分析', '设计', '架构', 'architecture', 'design', '方案', '比较', 'tradeoff', '权衡', '原理', '逻辑'];
  const simpleKw = ['什么是', '解释', 'explain', '翻译', 'translate', '总结', 'summarize', '你好', 'hello', '谁是', '介绍'];
  const fileOpKw = ['读取文件', 'read file', '写入文件', 'write file', '创建文件', 'delete file', 'ls ', 'dir ', 'grep '];

  if (codeEditKw.some(k => text.includes(k))) return 'code_edit';
  if (codeGenKw.some(k => text.includes(k))) return 'code_gen';
  if (reasonKw.some(k => text.includes(k))) return 'deep_reasoning';
  if (simpleKw.some(k => text.includes(k))) return 'simple_qa';
  if (fileOpKw.some(k => text.includes(k))) return 'file_ops';

  if (text.length < 300 && !tools?.length && (disableSmartRouting || !isHeavyContext)) return 'simple_qa';

  // 极限测试时，不管怎么样都默认不升级
  if (disableSmartRouting && !intent) return 'simple_qa';

  return null; // 需要 LLM 判断
}

// ─── LLM 意图识别（快速小模型）────────────────────────────────────────────
async function llmClassify(messages, tools, apiKey, endpoint, topicSummary = null) {
  if (IS_OFFLINE) return null; // 离线模式禁用 LLM 分类，全写由启发式规则决定
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
  const disableSmartRouting = !!routerConfig.disableSmartRouting;
  const totalTokens = estimateTokens(messages);
  const startTs = Date.now();

  const systemMsg = messages.find(m => m.role === 'system');
  const systemPromptLen = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content.length : JSON.stringify(systemMsg.content).length) : 0;
  const systemPromptTokens = Math.ceil(systemPromptLen / 3);
  const isHeavyContext = totalTokens > TOTAL_TOKENS_MAX_SMALL || systemPromptTokens > SYSTEM_PROMPT_MAX_SMALL;

  // ★ 话题追踪：从消息历史中重建话题状态
  const tracker = new TopicTracker(messages);
  const topicResult = tracker.getResult();
  const topicSummary = tracker.getTopicSummary();

  // 1. 快速规则预判
  let intent = quickHeuristic(messages, tools, totalTokens, disableSmartRouting);
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

  // 3. 兜底与升级逻辑
  // 如果分类为 simple_qa 但上下文很重，升级到 code_gen (Kimi) 或 deep_reasoning (DeepSeek)
  if (intent === 'simple_qa' && !disableSmartRouting) {
    if (isHeavyContext) {
      intent = 'deep_reasoning'; // 升级到推理模型以应对复杂上下文
      method = (method === 'llm' ? 'llm_upgraded' : 'heuristic_upgraded');
    }
  }

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

  // 判断是否分类到了小模型 (用于在 converter.js 中开启蒸馏保护)
  // 通过模型名称中的参数量（如 7b, 8b, 9b, 14b 等）或模型家族来判断
  const modelNameLower = target.model.toLowerCase();
  const isSmallModel = /\b([1-9]|1[0-4])b\b/.test(modelNameLower) || 
                       modelNameLower.includes('mini') || 
                       modelNameLower.includes('haiku');

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
    isSmallModel,
    isHeavyContext,
  };
}
