# Code Plan Proxy Architecture

This diagram illustrates the high-level architecture and data flow of the Code Plan Proxy.

```mermaid
graph TD
    subgraph Clients ["终端客户 (Clients)"]
        CL_CC["Claude Code"]
        CL_IDE["IDE Plugins (Continue/Roo)"]
        CL_DASH["Admin Dashboard"]
    end

    subgraph Endpoints ["接口层 (API Gateway)"]
        EP_ANT["/v1/messages (Anthropic)"]
        EP_OAI["/v1/chat/completions (OpenAI)"]
        EP_TTS["/v1/audio/speech (TTS)"]
        EP_ADM["/admin (Management)"]
    end

    subgraph Core ["代理核心 (Proxy Core Logic)"]
        SVR["server.js (Main Controller)"]
        DB["db.js (Auth & Quota)"]
        RTR["router.js (Smart Router)"]
        CVT["converter.js (Protocol Translation)"]
        MM["multimodal.js (Vision/ASR Pipeline)"]
        TTS["tts.js (Streaming TTS)"]
        TOPIC["topic.js (Context Management)"]
    end

    subgraph Backends ["后端平台 (Backends/Providers)"]
        PROV_SF["SiliconFlow (Primary)"]
        PROV_OAI["OneAPI / NewAPI"]
        PROV_DS["DeepSeek / GLM / NVIDIA"]
        PROV_LOC["Ollama (Local)"]
    end

    %% Data Flow
    CL_CC --> EP_ANT
    CL_IDE --> EP_OAI
    CL_DASH --> EP_ADM

    EP_ANT & EP_OAI --> SVR
    EP_TTS --> TTS
    
    SVR --> DB
    SVR --> RTR
    SVR --> MM
    SVR --> CVT
    
    CVT --> PROV_SF & PROV_OAI & PROV_DS & PROV_LOC
    
    %% Streaming Flow
    PROV_SF -- "Full/Stream Response" --> SVR
    SVR -- "Sentence Buffering" --> TTS
    TTS -- "Audio Deltas" --> SVR
    SVR -- "Server-Sent Events (SSE)" --> Clients
```

## 核心模块职责

1.  **API Gateway**: 同时兼容 Anthropic 和 OpenAI 协议，支持流式和非流式模型请求。
2.  **Smart Router**: 根据用户意图（代码生成、深度推理、简单对话）自动选择最匹配的后端模型（如 Qwen2.5-Coder vs DeepSeek-R1）。
3.  **Protocol Converter**: 将 Anthropic 的消息格式转换为各家厂商通用的 OpenAI 格式，反之亦然。支持 `tool_use`、`thinking` 等高级特性转换。
4.  **Pseudo-Multimodal Pipeline**: 离线/在线多模态桥接器。将图片通过视觉模型转为文字描述，将语音通过 ASR 转为文本后再发给普通 LLM，实现“万物皆可多模态”。
5.  **Streaming TTS**: 实现标准 OpenAI 低延迟流式语音输出。拦截 LLM 的生成流，按句子粒度异步合成音频包，嵌入 SSE 流中返回。
6.  **Admin System**: 内置轻量级文件数据库，支持多用户 Key 管理、Token 额度控制及可视化用量统计。
