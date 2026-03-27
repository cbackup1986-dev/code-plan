/**
 * topic.js — 话题追踪与上下文感知
 *
 * 功能:
 * 1. 从对话历史中推断话题结构（domain/topic/subtopic）
 * 2. 维护动态话题窗口（Soft 8 / Hard 12），LRU + Frequency 淘汰
 * 3. 检测话题变动：consistent / shift / return
 * 4. 为 context.js 提供话题感知的压缩建议
 */

// ─── 配置 ─────────────────────────────────────────────────────
export const TOPIC_CONFIG = {
  MAX_TOPICS_SOFT: 8,
  MAX_TOPICS_HARD: 12,
  EVICT_STRATEGY: 'LRU+frequency',
  PRESERVE_CURRENT: true,
};

// ─── 话题关键词映射（启发式分类） ────────────────────────────────
const TOPIC_KEYWORDS = [
  // frontend
  { domain: 'frontend', topic: 'react', subtopic: 'hooks',
    keywords: ['usestate', 'useeffect', 'usememo', 'usecallback', 'useref', 'usecontext', 'custom hook', '自定义hook'] },
  { domain: 'frontend', topic: 'react', subtopic: 'components',
    keywords: ['component', 'jsx', 'props', 'state', 'render', '组件', '渲染'] },
  { domain: 'frontend', topic: 'react', subtopic: 'router',
    keywords: ['react-router', 'route', 'navigate', '路由', 'usenavigation'] },
  { domain: 'frontend', topic: 'react', subtopic: 'general',
    keywords: ['react', 'react native', 'nextjs', 'next.js'] },
  { domain: 'frontend', topic: 'vue', subtopic: 'general',
    keywords: ['vue', 'vuex', 'pinia', 'composition api', 'nuxt'] },
  { domain: 'frontend', topic: 'css', subtopic: 'general',
    keywords: ['css', 'tailwind', 'scss', 'sass', 'flexbox', 'grid', '样式', '布局'] },
  { domain: 'frontend', topic: 'html', subtopic: 'general',
    keywords: ['html', 'dom', 'canvas', 'svg', 'semantic'] },

  // backend
  { domain: 'backend', topic: 'node', subtopic: 'general',
    keywords: ['node', 'express', 'koa', 'fastify', 'npm', 'package.json'] },
  { domain: 'backend', topic: 'python', subtopic: 'general',
    keywords: ['python', 'django', 'flask', 'fastapi', 'pip'] },
  { domain: 'backend', topic: 'database', subtopic: 'sql',
    keywords: ['sql', 'mysql', 'postgres', 'sqlite', '数据库', 'query', '查询'] },
  { domain: 'backend', topic: 'database', subtopic: 'nosql',
    keywords: ['mongodb', 'redis', 'elasticsearch', 'dynamodb'] },
  { domain: 'backend', topic: 'api', subtopic: 'general',
    keywords: ['api', 'rest', 'graphql', 'grpc', 'websocket', '接口'] },

  // devops
  { domain: 'devops', topic: 'docker', subtopic: 'general',
    keywords: ['docker', 'dockerfile', 'container', '容器', 'docker-compose'] },
  { domain: 'devops', topic: 'kubernetes', subtopic: 'general',
    keywords: ['kubernetes', 'k8s', 'kubectl', 'pod', 'deployment', 'service'] },
  { domain: 'devops', topic: 'cicd', subtopic: 'general',
    keywords: ['ci', 'cd', 'github actions', 'jenkins', 'pipeline', '部署', 'deploy'] },
  { domain: 'devops', topic: 'git', subtopic: 'general',
    keywords: ['git', 'branch', 'merge', 'rebase', 'commit', 'pull request'] },

  // ai/ml
  { domain: 'ai', topic: 'llm', subtopic: 'general',
    keywords: ['llm', 'gpt', 'claude', 'transformer', 'prompt', '大模型', '提示词'] },
  { domain: 'ai', topic: 'ml', subtopic: 'general',
    keywords: ['machine learning', '机器学习', 'model', 'training', '训练', 'neural'] },

  // general/life
  { domain: 'general', topic: 'cooking', subtopic: 'general',
    keywords: ['cook', 'recipe', '做饭', '烹饪', '炒菜', '煮', '食谱', '菜', '红烧', '烤', '蒸', '炖', '做菜', '厨房', '怎么做', '好吃', '面条', '饭', '肉'] },
  { domain: 'general', topic: 'math', subtopic: 'general',
    keywords: ['math', '数学', 'equation', '方程', 'calculus', '微积分'] },
  { domain: 'general', topic: 'writing', subtopic: 'general',
    keywords: ['write', '写作', 'essay', '文章', '翻译', 'translate'] },
];

// ─── 话题回归关键词（启发式 return 检测）────────────────────────
const RETURN_PATTERNS = [
  // 中文
  /回到(之前|刚才|前面)?(的|那个)?(.{1,20})(话题|问题|内容)?/,
  /继续(说|聊|讨论)(.{1,20})/,
  /关于(那个|之前的|刚才的)(.{1,20})/,
  /还是说回(.{1,20})/,
  /接着(之前|刚才)(.{1,20})/,
  /刚才(说的|聊的|那个)(.{1,20})/,
  // 英文
  /back to (.{1,30})/i,
  /going back to (.{1,30})/i,
  /returning to (.{1,30})/i,
  /let'?s continue (?:with )?(.{1,30})/i,
  /as I was saying about (.{1,30})/i,
  /earlier (question|topic|discussion) about (.{1,30})/i,
];

// ─── TopicTracker 类 ──────────────────────────────────────────
export class TopicTracker {
  /**
   * @param {Array} messages — 完整对话消息列表
   */
  constructor(messages = []) {
    this.messages = messages;
    /** @type {Array<TopicEntry>} LRU 排序，最近使用在前 */
    this.topicStack = [];
    this.currentTopic = null;
    this.movement = 'consistent';
    this.returnTarget = null;

    this._buildTopicHistory();
  }

  /**
   * 从对话历史中重建话题栈
   * 
   * 策略（两阶段）:
   * Phase 1: 从前 N-1 条 user 消息构建话题栈（历史）
   * Phase 2: 用最后一条 user 消息与栈比对，判定 movement
   */
  _buildTopicHistory() {
    const userMessages = this.messages.filter(m => m.role === 'user');
    if (userMessages.length === 0) return;

    // ── Phase 1: 构建历史栈（不含最后一条）──
    const historyMsgs = userMessages.slice(0, -1);
    for (let i = 0; i < historyMsgs.length; i++) {
      const text = this._extractText(historyMsgs[i]);
      const topic = this._classifyByKeywords(text);
      if (topic) {
        this._pushTopic(topic, i);
      }
    }

    // 记录"最后一条消息之前的栈顶话题"
    const prevTopKey = this.topicStack.length > 0 ? this.topicStack[0].key : null;

    // ── Phase 2: 分析最后一条 user 消息 ──
    const lastText = this._extractText(userMessages[userMessages.length - 1]);
    const lastTopic = this._classifyByKeywords(lastText);

    if (!lastTopic) return; // 无法识别话题
    this.currentTopic = lastTopic;
    const lastKey = this._topicKey(lastTopic);

    // 先检查关键词明确的 return（"回到..."、"back to..."）
    const returnInfo = this._detectReturn(lastText);
    if (returnInfo) {
      this.movement = 'return';
      this.returnTarget = returnInfo;
      this._pushTopic(lastTopic, userMessages.length - 1);
      return;
    }

    // 只有一条消息或栈为空 → consistent
    if (!prevTopKey) {
      this.movement = 'consistent';
      this._pushTopic(lastTopic, userMessages.length - 1);
      return;
    }

    // 当前话题与栈顶一致 → consistent
    if (lastKey === prevTopKey) {
      this.movement = 'consistent';
      this._pushTopic(lastTopic, userMessages.length - 1);
      return;
    }

    // 当前话题与栈顶的 broad topic (domain/topic) 一致 → consistent (subtopic 变化)
    const prevTop = this.topicStack[0];
    if (this._isSameBroadTopic(lastTopic, prevTop)) {
      this.movement = 'consistent';
      this._pushTopic(lastTopic, userMessages.length - 1);
      return;
    }

    // 当前话题是否在栈中存在过（被其他话题打断后重新出现）→ return
    const existsInStack = this.topicStack.some(e => e.key === lastKey);
    if (existsInStack) {
      this.movement = 'return';
      this.returnTarget = lastTopic;
      this._pushTopic(lastTopic, userMessages.length - 1);
      return;
    }

    // 全新话题 → shift
    this.movement = 'shift';
    this._pushTopic(lastTopic, userMessages.length - 1);
  }

  /**
   * 从消息中提取纯文本
   */
  _extractText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(' ');
    }
    return JSON.stringify(msg.content || '');
  }

  /**
   * 关键词启发式分类
   * @returns {{ domain, topic, subtopic } | null}
   */
  _classifyByKeywords(text) {
    const lower = text.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const entry of TOPIC_KEYWORDS) {
      let score = 0;
      for (const kw of entry.keywords) {
        if (lower.includes(kw)) {
          score += kw.length; // 长匹配优先
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { domain: entry.domain, topic: entry.topic, subtopic: entry.subtopic };
      }
    }

    return bestMatch;
  }

  /**
   * 生成话题唯一 key
   */
  _topicKey(t) {
    if (!t) return '';
    return `${t.domain}/${t.topic}/${t.subtopic}`;
  }

  /**
   * 判定两个 topic 是否在同一 domain/topic（忽略 subtopic）
   */
  _isSameBroadTopic(a, b) {
    if (!a || !b) return false;
    return a.domain === b.domain && a.topic === b.topic;
  }

  /**
   * 推入话题（LRU：移到栈顶；不存在则新增）
   */
  _pushTopic(topic, messageIndex) {
    const key = this._topicKey(topic);
    const existing = this.topicStack.findIndex(e => e.key === key);

    if (existing >= 0) {
      // LRU: 移到栈顶
      const entry = this.topicStack.splice(existing, 1)[0];
      entry.lastUsed = Date.now();
      entry.frequency++;
      entry.lastMessageIndex = messageIndex;
      this.topicStack.unshift(entry);
    } else {
      // 新话题
      this.topicStack.unshift({
        key,
        ...topic,
        lastUsed: Date.now(),
        frequency: 1,
        lastMessageIndex: messageIndex,
        score: 0,
      });
    }

    // 淘汰检查
    this._evict();
  }

  /**
   * LRU + Frequency 淘汰
   */
  _evict() {
    if (this.topicStack.length <= TOPIC_CONFIG.MAX_TOPICS_SOFT) return;

    // 计算 score
    const now = Date.now();
    for (const entry of this.topicStack) {
      // 将时间归一化到 [0, 1]（最近 1 小时内的都接近 1）
      const ageMs = now - entry.lastUsed;
      const recency = Math.max(0, 1 - ageMs / (60 * 60 * 1000));
      // frequency 归一化（cap 在 10）
      const freq = Math.min(entry.frequency / 10, 1);
      entry.score = recency * 0.7 + freq * 0.3;
    }

    // 超过 hard limit：按 score 淘汰最低的
    if (this.topicStack.length > TOPIC_CONFIG.MAX_TOPICS_HARD) {
      // 保护当前话题（index 0）
      const candidates = this.topicStack.slice(1);
      candidates.sort((a, b) => a.score - b.score);

      const toRemove = this.topicStack.length - TOPIC_CONFIG.MAX_TOPICS_SOFT;
      const removeKeys = new Set(
        candidates.slice(0, toRemove).map(e => e.key)
      );

      this.topicStack = this.topicStack.filter(
        (e, i) => i === 0 || !removeKeys.has(e.key)
      );
    }
  }

  /**
   * 检测是否用户在明确要求回到某个话题
   * @returns {object|null} 匹配到的话题，或 null
   */
  _detectReturn(text) {
    for (const pattern of RETURN_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // 提取关键词，在 topicStack 中寻找匹配
        const hint = (match[1] || match[2] || match[3] || '').trim().toLowerCase();
        if (!hint) continue;

        for (const entry of this.topicStack) {
          // 匹配 topic name 或 keyword
          if (entry.topic.includes(hint) || entry.key.includes(hint)) {
            return { domain: entry.domain, topic: entry.topic, subtopic: entry.subtopic };
          }
          // 反向匹配：hint 包含 topic name
          if (hint.includes(entry.topic)) {
            return { domain: entry.domain, topic: entry.topic, subtopic: entry.subtopic };
          }
        }
      }
    }
    return null;
  }

  /**
   * 获取话题检测结果（供 router.js 使用）
   */
  getResult() {
    return {
      currentTopic: this.currentTopic,
      movement: this.movement,
      returnTarget: this.returnTarget,
      stack: this.topicStack.map(e => ({
        key: e.key,
        score: Math.round(e.score * 100) / 100,
        frequency: e.frequency,
      })),
    };
  }

  /**
   * 获取话题摘要（供 LLM 分类器使用，紧凑格式）
   */
  getTopicSummary() {
    if (this.topicStack.length === 0) return null;

    return {
      current_topic: this.currentTopic
        ? this._topicKey(this.currentTopic)
        : null,
      recent_topics: this.topicStack.slice(0, 3).map(e => e.key),
      candidate_return_topics: this.topicStack
        .filter((_, i) => i > 0)
        .slice(0, 5)
        .map(e => e.key),
    };
  }

  /**
   * 获取话题感知的消息分段信息（供 context.js 使用）
   * 返回每条消息对应的话题标签
   */
  getMessageTopicTags() {
    const tags = [];
    let currentTopicKey = null;

    for (const msg of this.messages) {
      if (msg.role === 'user') {
        const text = this._extractText(msg);
        const topic = this._classifyByKeywords(text);
        if (topic) {
          currentTopicKey = this._topicKey(topic);
        }
      }
      tags.push({
        role: msg.role,
        topicKey: currentTopicKey,
      });
    }

    return tags;
  }
}

// ─── 供 LLM 分类器使用的 prompt 构建 ──────────────────────────
/**
 * 为 LLM 话题分类器生成 system prompt
 * @param {object} topicSummary - TopicTracker.getTopicSummary() 的输出
 */
export function buildTopicClassifierPrompt(topicSummary) {
  let contextSection = '';
  if (topicSummary) {
    contextSection = `
当前话题上下文：
- 最近话题: ${topicSummary.recent_topics.join(', ') || '无'}
- 可能回归的话题: ${topicSummary.candidate_return_topics.join(', ') || '无'}`;
  }

  return `你是一个话题分析器。根据用户消息和对话上下文，输出 JSON，不要解释：
{
  "topic": "domain/topic/subtopic",
  "movement": "consistent | shift | return"
}

规则：
- consistent: 用户在继续当前话题
- shift: 用户跳到了一个全新话题
- return: 用户回到了之前讨论过的话题
${contextSection}

只输出 JSON，不要其他内容。`;
}
