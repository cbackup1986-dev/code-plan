/**
 * providers.js
 */

// ─── CoT 强化前缀（行动前思考 + 工具合规） ────────────────────────────────
const TOOL_COMPLIANCE_PREFIX = `\
## 核心行为准则（最高优先级，每次回复前必须遵守）

### 思考框架
在每次调用工具之前，先在 <think> 标签内完成以下推理：
<think>
1. 我目前掌握的信息：[已读文件/已执行命令/已知错误]
2. 我还缺少什么：[需要哪些信息才能推进]
3. 下一步行动：[选择哪个工具，参数是什么，预期结果]
4. 风险评估：[这个操作有副作用吗？需要先备份吗？]
</think>

### 工具使用规则
1. 必须使用工具：读取文件、执行命令、操作文件系统时，绝对不能凭记忆猜测。
2. 先读后写：修改任何文件前，必须先用 Read 工具读取当前内容。
3. 验证结果：修改代码后，必须用 Bash 运行测试或编译命令验证。
4. 错误自愈：工具返回错误时，分析原因并重试，不要放弃。
5. 不提前结束：任务未完成时继续调用工具，不要输出"任务完成"等终止语。

`;

// ─── 观察后推理提示（proxy 层注入，tool result 之后） ──────────────────────
export const OBSERVATION_PROMPT = `\
[系统] 请在继续之前，先评估上述工具结果：
<observe>
- 结果是否符合预期？若不符合，原因是什么？
- 是否需要调整当前计划？
- 下一步应该做什么？
</observe>`;

// ─── 离线模式检测 ──────────────────────────────────────────────────────────
export const IS_OFFLINE = process.env.OFFLINE === 'true';

// ─── 视觉配置 ──────────────────────────────────────────────────────────────
export const VISION_CONFIG = IS_OFFLINE ? {
  endpoint: `${process.env.OLLAMA_URL || 'http://localhost:11434'}/v1/chat/completions`,
  apiKey: 'ollama',
  model: process.env.LOCAL_VISION_MODEL || 'llava',
  prompt: '请简洁准确地描述这张图片的核心内容。对于 UI 界面，描述布局和关键元素；对于代码或报错，提取核心信息。直接输出描述。',
} : {
  endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
  apiKey: process.env.SILICONFLOW_API_KEY || '',
  model: 'Qwen/Qwen3-VL-8B-Instruct',
  prompt: '请简洁准确地描述这张图片的核心内容。如果是 UI 界面，描述布局、文字和关键交互元素；如果是代码或报错，提取核心信息；如果是架构图或流程图，描述关键节点和流向。直接输出描述，不要解释。',
};

export const AUDIO_CONFIG = IS_OFFLINE ? {
  endpoint: process.env.LOCAL_ASR_URL || 'http://localhost:8080/v1/audio/transcriptions',
  apiKey: 'whisper',
  model: 'whisper-1',
} : {
  endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
  apiKey: process.env.SILICONFLOW_API_KEY || '',
  model: 'FunAudioLLM/SenseVoiceSmall',
};

export const PROVIDERS = {
  glm: {
    name: 'GLM (智谱)',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    apiKey: process.env.GLM_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    multimodal: true,
    maxContextTokens: 60000,
    timeoutMs: 120000,
    modelMap: {
      'claude-opus-4-20250514': 'glm-4-plus',
      'claude-opus-4-5': 'glm-4-plus',
      'claude-sonnet-4-20250514': 'glm-4',
      'claude-sonnet-4-5': 'glm-4',
      'claude-haiku-4-5-20251001': 'glm-4-flash',
      'claude-haiku-4-5': 'glm-4-flash',
      default: 'glm-4',
    },
  },

  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    maxContextTokens: 55000,
    multimodal: false,
    timeoutMs: 150000,
    modelMap: {
      'claude-opus-4-20250514': 'deepseek-chat',
      'claude-opus-4-5': 'deepseek-chat',
      'claude-sonnet-4-20250514': 'deepseek-chat',
      'claude-sonnet-4-5': 'deepseek-chat',
      'claude-haiku-4-5-20251001': 'deepseek-chat',
      'claude-haiku-4-5': 'deepseek-chat',
      default: 'deepseek-chat',
    },
  },

  deepseek_r1: {
    name: 'DeepSeek-R1 (推理)',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    injectPrefix: false,
    injectObservation: false,
    stripThinking: true,
    maxContextTokens: 55000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'deepseek-reasoner',
      'claude-opus-4-5': 'deepseek-reasoner',
      'claude-sonnet-4-20250514': 'deepseek-reasoner',
      'claude-sonnet-4-5': 'deepseek-reasoner',
      'claude-haiku-4-5-20251001': 'deepseek-chat',
      'claude-haiku-4-5': 'deepseek-chat',
      default: 'deepseek-reasoner',
    },
  },

  qwen: {
    name: 'Qwen (阿里云)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: process.env.QWEN_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    maxContextTokens: 60000,
    multimodal: true,
    timeoutMs: 120000,
    modelMap: {
      'claude-opus-4-20250514': 'qwen-max',
      'claude-opus-4-5': 'qwen-max',
      'claude-sonnet-4-20250514': 'qwen-plus',
      'claude-sonnet-4-5': 'qwen-plus',
      'claude-haiku-4-5-20251001': 'qwen-turbo',
      'claude-haiku-4-5': 'qwen-turbo',
      default: 'qwen-plus',
    },
  },

  ollama: {
    name: 'Ollama (本地)',
    endpoint: `${process.env.OLLAMA_URL || 'http://localhost:11434'}/v1/chat/completions`,
    apiKey: 'ollama',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    maxContextTokens: 30000,
    multimodal: false,
    timeoutMs: 300000,
    modelMap: {
      default: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
    },
  },

  nvidia: {
    name: 'NVIDIA Build',
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    apiKey: process.env.NVIDIA_API_KEY || '',
    injectPrefix: false,
    injectObservation: false,
    stripThinking: false,
    isRouter: true,
    maxContextTokens: 60000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'moonshotai/kimi-k2.5',
      'claude-opus-4-5': 'moonshotai/kimi-k2.5',
      'claude-sonnet-4-20250514': 'moonshotai/kimi-k2.5',
      'claude-sonnet-4-5': 'moonshotai/kimi-k2.5',
      'claude-haiku-4-5-20251001': 'moonshotai/kimi-k2-instruct',
      'claude-haiku-4-5': 'moonshotai/kimi-k2-instruct',
      default: 'moonshotai/kimi-k2.5',
    },
  },

  deepseek_sf: {
    name: 'SiliconFlow DeepSeek (V3.2)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    maxContextTokens: 64000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'deepseek-ai/DeepSeek-V3.2',
      'claude-opus-4-5': 'deepseek-ai/DeepSeek-V3.2',
      'claude-sonnet-4-20250514': 'deepseek-ai/DeepSeek-V3.2',
      'claude-sonnet-4-5': 'deepseek-ai/DeepSeek-V3.2',
      'claude-haiku-4-5-20251001': 'Qwen/Qwen2.5-72B-Instruct',
      'claude-haiku-4-5': 'Qwen/Qwen2.5-72B-Instruct',
      default: 'deepseek-ai/DeepSeek-V3.2',
    },
  },

  kimi_sf: {
    name: 'SiliconFlow Kimi (K2.5)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    injectPrefix: false,
    injectObservation: false,
    stripThinking: false,
    requiresReasoningPlaceholder: true,
    maxContextTokens: 64000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'Pro/moonshotai/Kimi-K2.5',
      'claude-opus-4-5': 'Pro/moonshotai/Kimi-K2.5',
      'claude-sonnet-4-20250514': 'Pro/moonshotai/Kimi-K2.5',
      'claude-sonnet-4-5': 'Pro/moonshotai/Kimi-K2.5',
      'claude-haiku-4-5-20251001': 'Pro/moonshotai/Kimi-K2-Instruct-0905',
      'claude-haiku-4-5': 'Pro/moonshotai/Kimi-K2-Instruct-0905',
      default: 'Pro/moonshotai/Kimi-K2.5',
    },
  },

  optimal_sf: {
    name: 'SiliconFlow (最佳组合)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    isRouter: true,
    requiresReasoningPlaceholder: true,
    maxContextTokens: 64000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'deepseek-ai/DeepSeek-V3.2',
      'claude-opus-4-5': 'deepseek-ai/DeepSeek-V3.2',
      'claude-sonnet-4-20250514': 'Pro/moonshotai/Kimi-K2.5',
      'claude-sonnet-4-5': 'Pro/moonshotai/Kimi-K2.5',
      'claude-haiku-4-5-20251001': 'Qwen/Qwen2.5-Coder-32B-Instruct',
      'claude-haiku-4-5': 'Qwen/Qwen2.5-Coder-32B-Instruct',
      default: 'Pro/moonshotai/Kimi-K2.5',
    },
  },

  fast_sf: {
    name: 'SiliconFlow (快速通道)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    apiKey: process.env.SILICONFLOW_API_KEY || '',
    injectPrefix: false,
    injectObservation: false,
    stripThinking: false,
    isRouter: true,
    maxContextTokens: 32000,
    multimodal: false,
    timeoutMs: 120000,
    modelMap: {
      'claude-opus-4-20250514': 'Qwen/Qwen2.5-14B-Instruct',
      'claude-sonnet-4-20250514': 'Qwen/Qwen3.5-9B',
      'claude-haiku-4-5': 'Qwen/Qwen3.5-9B',
      default: 'Qwen/Qwen3.5-9B',
    },
  },

  oneapi: {
    name: 'OneAPI (OpenAI 兼容)',
    endpoint: process.env.ONEAPI_ENDPOINT || '',
    apiKey: process.env.ONEAPI_API_KEY || '',
    injectPrefix: true,
    injectObservation: false,
    stripThinking: false,
    maxContextTokens: 64000,
    multimodal: false,
    timeoutMs: 180000,
    modelMap: {
      'claude-opus-4-20250514': 'gpt-4o',
      'claude-sonnet-4-20250514': 'gpt-4o',
      'claude-haiku-4-5': 'gpt-4o-mini',
      default: 'gpt-4o',
    },
    visionConfig: {
      endpoint: process.env.ONEAPI_ENDPOINT || '',
      apiKey: process.env.ONEAPI_API_KEY || '',
      model: process.env.ONEAPI_VISION_MODEL || 'gpt-4o',
      prompt: '请简洁准确地描述这张图片的核心内容。如果是 UI 界面，描述布局、文字和关键交互元素；如果是代码或报错，提取核心信息；如果是架构图或流程图，描述关键节点和流向。直接输出描述，不要解释。',
    },
    audioConfig: {
      endpoint: (process.env.ONEAPI_ENDPOINT || '').replace(/\/chat\/completions$/, '/audio/transcriptions'),
      apiKey: process.env.ONEAPI_API_KEY || '',
      model: process.env.ONEAPI_AUDIO_MODEL || 'whisper-1',
    },
  },
};

export function getProvider(name) {
  return PROVIDERS[name] || PROVIDERS.nvidia;
}

export function mapModel(provider, claudeModel) {
  return provider.modelMap[claudeModel] || provider.modelMap.default;
}

export function getToolPrefix(provider) {
  return provider.injectPrefix ? TOOL_COMPLIANCE_PREFIX : '';
}
