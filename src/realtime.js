import { randomUUID } from 'crypto';
import { 
  getUserByKey, checkAndConsumeQuota, recordUsage, recordConversation 
} from './db.js';
import { 
  PROVIDERS, getProvider, AUDIO_CONFIG, TTS_CONFIG, IS_OFFLINE 
} from './providers.js';
import { convertRequest, openAIToAnthropicMessages } from './converter.js';
import { routeRequest } from './router.js';
import { transcribeAudio } from './multimodal.js';
import { synthesize } from './tts.js';

/**
 * handleRealtimeWebSocket - 处理 ESP32 的实时音频 WebSocket 连接
 * 
 * 协议设计：
 * 1. 客户端连接时通过 query 或 header 传递 API Key
 * 2. 客户端发送原始 PCM 音频分片 (Binary)
 * 3. 服务端进行 VAD 或静音检测，触发 ASR -> LLM -> TTS
 * 4. 服务端返回 JSON 控制消息 或 Binary 音频数据 (MP3/PCM)
 */
export async function handleRealtimeWebSocket(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = url.searchParams.get('key') || req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const user = getUserByKey(key);

  if (!user || !user.active) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    ws.close();
    return;
  }

  const startTime = new Date();
  console.log(`[Realtime] [Start] User: ${user.username} | IP: ${req.socket.remoteAddress} | ${startTime.toLocaleString()}`);

  let audioBuffer = [];
  let silenceCount = 0;
  let isProcessing = false;
  let isFirstTurn = true; // NEW: Track the first turn after connection
  const SILENCE_THRESHOLD = 250; // Lowered to be more sensitive to quiet speech
  const SILENCE_CHUNKS_LIMIT = 80; // ~2s of silence before finalizing (increased for better natural pauses)
  const MAX_CHUNKS_LIMIT = 400; // Force process after ~12 seconds to prevent infinite buffering

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (isProcessing) return; // 正在处理上一轮，丢弃当前输入

      const buffer = Buffer.from(data);
      audioBuffer.push(buffer);

      // 简单的 VAD 检测 (计算 RMS 能量)
      let energy = 0;
      for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
          const sample = buffer.readInt16LE(i);
          energy += Math.abs(sample);
        }
      }
      const avgEnergy = energy / (buffer.length / 2);
      
      // Silence detection logic completed (logging removed)
      if (avgEnergy < SILENCE_THRESHOLD) {
        silenceCount++;
      } else {
        silenceCount = 0;
      }

      // 触发识别条件：持续静音足够长，或者录音达到硬限制最大长度
      const isSilenceTrigger = (silenceCount > SILENCE_CHUNKS_LIMIT && audioBuffer.length > 50);
      const isMaxDurationTrigger = (audioBuffer.length >= MAX_CHUNKS_LIMIT);

      if (isSilenceTrigger || isMaxDurationTrigger) {
        if (isMaxDurationTrigger) console.log(`[Realtime] Max recording duration reached, forcing process.`);
        await processVoiceturn();
      }
    } else {
      // 处理文本消息 (如配置更新)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e) {}
    }
  });

  async function processVoiceturn() {
    isProcessing = true;
    silenceCount = 0;
    const pcmData = Buffer.concat(audioBuffer);
    audioBuffer = [];

    // 为 PCM 数据添加 44 字节 WAV 头
    const wavHeader = getWavHeader(pcmData.length, 16000, 1, 16);
    const fullAudio = Buffer.concat([wavHeader, pcmData]);

    console.log(`[Realtime] Processing voice turn (${fullAudio.length} bytes wrapped in WAV)...`);
    
    // [DIAG] 分析收到的PCM数据质量
    let pcmPeak = 0, pcmSum = 0;
    for (let i = 0; i < pcmData.length - 1; i += 2) {
      const sample = Math.abs(pcmData.readInt16LE(i));
      if (sample > pcmPeak) pcmPeak = sample;
      pcmSum += sample;
    }
    const pcmSamples = pcmData.length / 2;
    const pcmAvg = Math.round(pcmSum / pcmSamples);
    const pcmDurationMs = Math.round(pcmSamples / 16000 * 1000);
    console.log(`[Realtime] PCM Stats: duration=${pcmDurationMs}ms, samples=${pcmSamples}, peak=${pcmPeak}, avg=${pcmAvg}`);
    
    ws.send(JSON.stringify({ type: 'status', status: 'transcribing' }));

    const requestId = randomUUID();
    const provider = getProvider(user.provider || 'nvidia');
    
    try {
      // 1. ASR - 语音转文字
      const base64Audio = fullAudio.toString('base64');
      const audioCfg = provider.audioConfig || AUDIO_CONFIG;
      console.log(`[Realtime] ASR Config: endpoint=${audioCfg.endpoint}, model=${audioCfg.model}`);
      
      const text = await transcribeAudio(
        { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: base64Audio } },
        { ...audioCfg, apiKey: provider.apiKey || audioCfg.apiKey }
      );

      console.log(`[Realtime] ASR Result: "${text}"`);
      ws.send(JSON.stringify({ type: 'transcript', text }));

      // 检查转录是否有效 (包含内容且不是 ASR 占位符)
      const isMeaningful = text.trim() !== '' && 
                           !text.includes('[无转录内容]') && 
                           !text.includes('[语音转录失败');

      if (!isMeaningful || text.trim().length < 2) {
          console.log(`[Realtime] Skipping LLM: No meaningful content detected ("${text}")`);
          ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
          isProcessing = false;
          // 若为首回合但无内容，保持 isFirstTurn=true 等待下次真正发言
          return;
      }

      isFirstTurn = false; // 只有在识别到真实内容后，才标记对话状态开始
      let llmText = text;

      // 2. LLM - 智能对话
      ws.send(JSON.stringify({ type: 'status', status: 'thinking' }));
      
      const messages = [{ role: 'user', content: llmText }];
      const converted = convertRequest({ 
        model: 'claude-3-5-sonnet-latest', 
        messages, 
        stream: true 
      }, provider);

      console.log(`[Realtime] Calling LLM: ${provider.endpoint} (Model: ${converted.model})`);
      const startTime = Date.now();
      const res = await fetch(provider.endpoint, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${provider.apiKey}` 
        },
        body: JSON.stringify(converted),
        signal: AbortSignal.timeout(30000) // 30s timeout
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`LLM API Error: ${res.status} ${res.statusText} - ${errorText.slice(0, 100)}`);
      }

      console.log(`[Realtime] LLM Connection established, status: ${res.status}`);

      // 3. TTS 流式处理
      const decoder = new TextDecoder();
      let fullResponseText = '';
      let currentSentence = ''; 
      let firstChunkReceived = false;

      // Handle the stream
      if (!res.body) throw new Error("LLM response body is empty");
      
      const streamReader = res.body.getReader();
      console.log(`[Realtime] Starting to read LLM stream...`);

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        if (!firstChunkReceived) {
            firstChunkReceived = true;
            console.log(`[Realtime] LLM First chunk received after ${Date.now() - startTime}ms`);
        }
        const lines = decoder.decode(value).split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.slice(5).trim();
          if (jsonStr === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonStr);
            const delta = data.choices?.[0]?.delta;
            const char = delta?.content || '';
            if (char) {
                // console.log(`[Realtime] LLM Chunk: "${char}"`);
                fullResponseText += char;
                currentSentence += char;
            }
            
            // Trigger TTS on sentence boundaries or after 20 characters
            if (char && (/[，。！？\n]/.test(char) || currentSentence.length > 20)) {
                const s = currentSentence.trim();
                if (s.length > 1) {
                    console.log(`[Realtime] Sending to TTS: "${s}"`);
                    await sendTTS(s, provider, requestId);
                    currentSentence = '';
                }
            }
          } catch (e) {}
        }
      }

      if (!firstChunkReceived) {
          console.warn(`[Realtime] LLM returned empty stream for: "${text}"`);
      }

      if (currentSentence.trim().length > 0) {
        const s = currentSentence.trim();
        console.log(`[Realtime] Sending final sentence to TTS: "${s}"`);
        await sendTTS(s, provider, requestId);
      }

      ws.send(JSON.stringify({ type: 'llm_done', text: fullResponseText }));
      console.log(`[Realtime] [Done] Voice turn processing finished. Latency: ${Date.now() - startTime}ms`);
      
      // 记录使用量
      recordUsage({
        user_id: user.id,
        request_id: requestId,
        claude_model: 'claude-3-5-sonnet-latest',
        backend_model: converted.model,
        input_tokens: 0, // 简化处理
        output_tokens: Math.ceil(fullResponseText.length / 2),
        latency_ms: Date.now() - startTime
      });

    } catch (err) {
      console.error(`[Realtime] Error: ${err.message}`);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    } finally {
      isProcessing = false;
    }
  }

  async function sendTTS(text, provider, requestId) {
    try {
      const audio = await synthesize(text, {
        ...provider.ttsConfig || TTS_CONFIG,
        response_format: 'pcm'
      });
      // 发送二进制音频数据 (PCM)
      // Binary chunking to prevent ESP32 WebSocket buffer overflow
      const chunkSize = 1024;
      for (let i = 0; i < audio.length; i += chunkSize) {
          const chunk = audio.slice(i, Math.min(i + chunkSize, audio.length));
          ws.send(chunk);
      }
      console.log(`[Realtime] Sent ${audio.length} bytes of PCM to robot in chunks`);
      // 发送文本同步消息
      ws.send(JSON.stringify({ type: 'tts_chunk', text }));
    } catch (e) {
      console.error(`[Realtime] TTS Error: ${e.message}`);
      ws.send(JSON.stringify({ type: 'error', message: `TTS Error: ${e.message}` }));
    }
  }

  ws.on('close', () => {
    const duration = ((Date.now() - startTime.getTime()) / 1000).toFixed(1);
    console.log(`[Realtime] [End] User: ${user.username} | Duration: ${duration}s | ${new Date().toLocaleString()}`);
    audioBuffer = [];
  });
}

/**
 * 生成 WAV 文件头
 */
function getWavHeader(dataLength, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}
