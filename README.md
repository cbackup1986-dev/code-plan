# Code Plan Proxy ⚡

**Anthropic API Compatible Proxy Server**. Enable advanced AI coding tools like Claude Code, OpenClaw, and Cursor to work seamlessly with LLM providers such as NVIDIA Build, Moonshot (Kimi), DeepSeek, and more. 

---

## 🌟 Why Code Plan Proxy?

Most modern coding agents (like **Claude Code**) require a native Anthropic API to function. However, the direct Anthropic costs can be high, or its availability limited. 

**Code Plan Proxy** acts as a high-performance bridge:
- 💰 **Cost Efficiency**: Use models like **DeepSeek V3** or **Kimi K2.5** (via NVIDIA) at a fraction of the cost, while maintaining "Claude-level" reasoning.
- 🛠️ **Agent Optimization**: Unlike generic proxies, we've fine-tuned the **Streaming Tool Use** protocol. This means Claude Code can perfectly execute `Bash`, `Edit`, and `View` tools without formatting errors.
- 🔒 **Privacy & Control**: Run as a central gateway for your team with built-in quota management and usage logging.

## 🎯 Use Cases

- **Claude Code + High Power**: Use NVIDIA's 400B Llama or Moonshot K2.5 to power your autonomous agent loop.
- **Cursor + Local/Private Models**: Connect Cursor to your private **Ollama** instance or specialized local fine-tuned models.
- **Team API Gateway**: Deploy a single instance for your dev team, providing managed access to various LLM backends through a unified Claude-compatible key.

---

## 🚀 Quick Start

### Option 1: Docker (Recommended)
```bash
# 1. Prepare configuration
cp .env.example .env
# Edit .env and add your NVIDIA_API_KEY (Default Provider)

# 2. Start the service
docker compose up -d

# 3. Create your first user
curl -X POST http://localhost:3000/admin/users \
  -H "x-admin-key: admin" \
  -H "Content-Type: application/json" \
  -d '{"username":"dev-user","provider":"nvidia"}'
```

### Option 2: Local Installation
```bash
npm install
cp .env.example .env
npm start
```
Visit `http://localhost:3000/admin` to access the Web Dashboard (Default Key: `admin`).

---

## 🛠️ Client Configuration

### 1. Claude Code
```bash
export ANTHROPIC_BASE_URL=http://localhost:3000
export ANTHROPIC_AUTH_TOKEN=cp-your-user-key

claude
```

### 2. OpenClaw
- **API Base URL**: `http://localhost:3000/v1`
- **API Key**: `cp-your-user-key`
- **Model Name**: Use standard Claude names (e.g., `claude-3-5-sonnet-latest`). The proxy automatically maps these to the backend provider.

---

## 🤖 Supported Providers & Models

| Provider | ID | Default Mapping (Claude Sonnet/Opus) | Notes |
|---|---|---|---|
| **NVIDIA Build** | `nvidia` | `moonshotai/kimi-k2.5` | **Recommended**. Built-in Kimi support for superior reasoning. |
| **DeepSeek** | `deepseek` | `deepseek-chat` / `deepseek-reasoner` | Best value. Native R1 reasoning support. |
| **Zhipu GLM** | `glm` | `glm-4-plus` | Top-tier Chinese LLM. |
| **Alibaba Qwen** | `qwen` | `qwen-max` | Excellent instruction following. |
| **OneAPI** | `oneapi` | `gpt-4o` | **New**. OpenAI-compatible bridge for multiple backends. |
| **Ollama** | `ollama` | Custom via Environment | Perfect for local/private deployments. |

- **低延迟流式 TTS**: 支持 OpenAI 多模态协议，在 `/v1/chat/completions` 中启用 `modalities: ["text", "audio"]` 即可实时流式输出语音。
- **原生多模态透传**: 在 `src/providers.js` 中设置 `multimodal: true` 即可跳过代理端的 OCR/ASR 转换，直接使用后端模型的原生能力（如 Qwen3.5-VL）。
- **智能对话路由**: 根据意图自动选择（如 `nvidia` / `siliconflow`），支持代码增强与复杂推理。
- **多端协议兼容**: 同时支持 OpenAI 指令式和 Anthropic 消息式（Claude）标准。

> [!NOTE]
> For the NVIDIA provider, we have pre-configured high-performance **Moonshot (Kimi)** models to ensure the best agent performance.

---

## 📖 Key Features
- ✅ **Streaming Compatibility**: Native support for Anthropic SSE streaming protocol and tool-use deltas.
- ✅ **Intelligent Routing**: Automatic model selection based on intent (Code vs. Reasoning).
- ✅ **Pseudo-Multimodal Pipeline**: Vision (Image-to-Text) and ASR (Audio-to-Text) support for text-only backends.
- ✅ **Low-Latency Streaming TTS**: Real-time audio chunks synced with text generation.
- ✅ **Auto-Retry**: Automatic backend retry logic to ensure agent loop stability.
- ✅ **Quota Management**: Rate-limiting and quota windows per user to control API costs.
- ✅ **Lightweight Deployment**: Single-file database (LowDB), Docker-native, zero external DB dependencies required.

## ⚙️ Environment Variables

| Variable | Description | Default |
|---|---|---|
| `GLOBAL_TIMEOUT_MS` | Global override for backend request timeout (ms) | `null` |
| `ONEAPI_ENDPOINT` | Base URL for OneAPI (e.g. `https://oneapi.example.com/v1`) | `""` |
| `ONEAPI_API_KEY` | API Key for OneAPI | `""` |
| `OFFLINE` | Enable local Ollama/Mock modes | `false` |

- `ONEAPI_ENDPOINT`, `ONEAPI_API_KEY`: OneAPI / OpenAI 兼容中转配置。
- `ADMIN_KEY`: 管理后台登录秘钥（默认 `admin`）。
- `GLOBAL_TIMEOUT_MS`: 全局后端请求超时时间（默认 120s）。

## 🤝 Contributing
Contributions are welcome! Please check [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines and project structure.

---

---

## ⚖️ 免责声明 (Legal Disclaimer)

本项目是一个**非官方、社区驱动的开源项目**。
- **商标声明**："Anthropic", "Claude", "NVIDIA", "Moonshot", "DeepSeek" 等模型名称均为其各自持有者的商标。在本项目中使用这些名称仅用于兼容性描述。
- **互操作性**：本工具仅供个人和开发使用，旨在提高不同 AI 工具之间的互操作性。
- **服务条款合规**：用户有责任遵守其各自所使用的 LLM 供应商（如 NVIDIA, SiliconFlow 等）的服务条款。
- **责任限制**：本软件的作者不对因使用本工具而导致的任何账户封禁、账单纠纷、法律后果或任何形式的损失负责。

This is an **unofficial, community-driven open-source project**. 
- **Trademarks**: "Anthropic", "Claude", "NVIDIA", "Moonshot", "DeepSeek", and other model names are trademarks of their respective owners. Their use in this project is strictly for compatibility description purposes.
- **Interoperability**: This tool is provided solely for personal and development use to improve interoperability between AI tools. 
- **TOS Compliance**: Users are responsible for complying with the Terms of Service of their respective LLM providers. 
- **Liability**: The authors of this software are not responsible for any account suspensions, billing issues, or legal consequences arising from the use of this tool.

--- 
*Made with ❤️ for AI Engineers.*
