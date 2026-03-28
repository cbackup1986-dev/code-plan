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

## 🤝 Contributing
Contributions are welcome! Please check [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines and project structure.

---

## ⚖️ Legal Disclaimer

This is an **unofficial, community-driven open-source project**. 
- **Trademarks**: "Anthropic", "Claude", "NVIDIA", "Moonshot", "DeepSeek", and other model names are trademarks of their respective owners. Their use in this project is strictly for compatibility description purposes.
- **Interoperability**: This tool is provided solely for personal and development use to improve interoperability between AI tools. 
- **TOS Compliance**: Users are responsible for complying with the Terms of Service of their respective LLM providers. 
- **Liability**: The authors of this software are not responsible for any account suspensions, billing issues, or legal consequences arising from the use of this tool.

--- 
*Made with ❤️ for AI Engineers.*
