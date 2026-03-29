/**
 * multimodal.js — 图片/音频转文字（伪多模态）
 *
 * 优化点：
 * 1. VL API 超时 60s → 18s，超时直接返回占位而非卡住
 * 2. compressBase64Image 改为一次性压缩，阈值放宽到 500KB，减少 sharp 重试
 * 3. 多图并行处理（Promise.all）加 per-image 超时保险
 * 4. scan 只取最近 10 条消息的图片（避免重复描述历史图片）
 */

const VL_TIMEOUT_MS = 18_000;   // 视觉模型单张图片超时
const ASR_TIMEOUT_MS = 15_000;  // 语音识别超时
const COMPRESS_THRESHOLD = 500_000; // bytes，低于此值不压缩（原来是 100KB 太激进）
const MAX_BASE64_LENGTH = 90_000;   // base64 字符数上限
const HISTORICAL_IMAGE_LIMIT = 100; // 不再随意丢弃历史图片，依靠缓存保证性能

// 本地内存缓存，生命周期为进程存活期间
const imageCache = new Map(); 

/**
 * 处理多模态消息：将图片转化为描述，将语音转化为转录
 * @returns {Promise<{isChanged: boolean, messages: any[]}>}
 */
export async function processMultimodalMessages(messages, visionConfig, audioConfig, logger = console.log, signal = null) {
  const originalJSON = JSON.stringify(messages);
  // 处理全部消息（或至少是大范围消息），因为历史中的图片需要被持续转换为文本
  let processedTail = JSON.parse(JSON.stringify(messages));
  const head = [];

  if (visionConfig?.apiKey) {
    processedTail = await describeImagesInMessages(processedTail, visionConfig, logger, signal);
  }

  if (audioConfig?.apiKey) {
    processedTail = await transcribeAudioInMessages(processedTail, audioConfig, logger, signal);
  }

  const processedMessages = [...head, ...processedTail];
  const isChanged = JSON.stringify(processedMessages) !== originalJSON;
  return { isChanged, messages: processedMessages };
}

/**
 * 检查是否有图片或音频内容（递归扫描）
 */
export function hasMultimodalInput(msgs) {
  if (!Array.isArray(msgs)) return false;
  return msgs.some(msg => {
    if (typeof msg.content === 'string') return false;
    if (Array.isArray(msg.content)) {
      return msg.content.some(block => {
        if (block.type === 'image' || block.type === 'image_url' || block.type === 'audio' || block.type === 'input_audio') return true;
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          return block.content.some(sub => sub.type === 'image' || sub.type === 'image_url' || sub.type === 'audio' || sub.type === 'input_audio');
        }
        return false;
      });
    }
    return false;
  });
}

// ─── 图片描述 ──────────────────────────────────────────────────────────────

async function describeImagesInMessages(messages, config, logger, signal) {
  const imageBlocks = [];

  function scan(content, mIdx, path = []) {
    if (!content) return;
    if (typeof content === 'string') return;
    if (!Array.isArray(content)) return;

    content.forEach((block, bIdx) => {
      if (block.type === 'image' || block.type === 'image_url') {
        imageBlocks.push({ mIdx, path: [...path, bIdx], block });
      } else if (block.type === 'tool_result' && block.content) {
        scan(block.content, mIdx, [...path, bIdx, 'content']);
      }
    });
  }

  messages.forEach((msg, mIdx) => scan(msg.content, mIdx));

  if (imageBlocks.length === 0) return messages;

  logger('info', 'multimodal', 'describing_images', { count: imageBlocks.length });

  // 并行处理，每张图有独立超时保险
  const descriptions = await Promise.all(imageBlocks.map(async ({ block }, index) => {
    const startTime = Date.now();
    try {
      const desc = await Promise.race([
        getCachedOrDescribeImage(block, { ...config, signal }, logger),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('VL_TIMEOUT')), VL_TIMEOUT_MS)
        ),
      ]);
      logger('debug', 'multimodal', `image_ok_${index}`, { ms: Date.now() - startTime });
      return desc;
    } catch (err) {
      const ms = Date.now() - startTime;
      if (err.message === 'VL_TIMEOUT') {
        logger('warn', 'multimodal', `image_timeout_${index}`, { ms });
        return '[图片：视觉模型响应超时，已跳过]';
      }
      if (err.message === 'DETECTED_LOCAL_PATH') {
        return '[检测到本地图片路径。请直接将图片拖入上传，或使用工具读取后发送。]';
      }
      if (err.message === 'IMAGE_TOO_LARGE') {
        return '[图片压缩后仍超过视觉模型输入限制，请手动裁剪后重试。]';
      }
      logger('error', 'multimodal', `image_failed_${index}`, { error: err.message, ms });
      return `[图片描述失败: ${err.message}]`;
    }
  }));

  // 回填描述
  const newMessages = JSON.parse(JSON.stringify(messages));
  imageBlocks.forEach(({ mIdx, path }, i) => {
    let target = newMessages[mIdx].content;
    for (let j = 0; j < path.length - 1; j++) {
      target = target[path[j]];
    }
    const lastIdx = path[path.length - 1];
    const isLatestTurn = mIdx === newMessages.length - 1;
    // 使用全局历史序号（或在该回合内的序号）标识图片
    const imgId = i + 1; 
    const header = isLatestTurn 
      ? `[🚨当前关键图片 #${imgId} 分析 (${config.model?.split('/').pop() || 'VL'})]`
      : `[图片 #${imgId} 内容描述 (${config.model?.split('/').pop() || 'VL'})]`;

    target[lastIdx] = {
      type: 'text',
      text: `${header}: ${descriptions[i]}`,
    };
  });

  // 合并相邻文本块，简化消息
  newMessages.forEach(msg => {
    if (!Array.isArray(msg.content)) return;
    const combined = [];
    for (const block of msg.content) {
      if (
        block.type === 'text' &&
        combined.length > 0 &&
        combined[combined.length - 1].type === 'text'
      ) {
        combined[combined.length - 1].text += '\n' + block.text;
      } else {
        combined.push(block);
      }
    }
    msg.content = combined.length === 1 && combined[0].type === 'text'
      ? combined[0].text
      : combined;
  });

  return newMessages;
}

async function getCachedOrDescribeImage(imageBlock, config, logger) {
  const imageUrl = getImageUrl(imageBlock);
  if (!imageUrl) throw new Error('No image URL or data found');

  // 如果是 base64，计算 hash 进行缓存
  let cacheKey = null;
  if (imageUrl.startsWith('data:')) {
    const crypto = await import('crypto');
    cacheKey = crypto.createHash('sha256').update(imageUrl).digest('hex');
    if (imageCache.has(cacheKey)) {
      logger('debug', 'multimodal', 'cache_hit', { hash: cacheKey.slice(0, 8) });
      return imageCache.get(cacheKey);
    }
  }

  const description = await describeImage(imageUrl, config);
  
  if (cacheKey) {
    imageCache.set(cacheKey, description);
    // 简单的缓存淘汰逻辑：超过 100 条则清空（由于代理通常处理少量频繁图片，这足够了）
    if (imageCache.size > 100) imageCache.clear();
  }
  
  return description;
}

function getImageUrl(imageBlock) {
  if (imageBlock.type === 'image_url') {
    return imageBlock.image_url?.url || '';
  } else if (imageBlock.source?.type === 'base64') {
    return `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`;
  } else if (imageBlock.source?.url) {
    return imageBlock.source.url;
  }
  return '';
}

async function describeImage(imageUrl, config) {
  const { apiKey, endpoint, model, prompt, signal } = config;

  if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
    throw new Error('DETECTED_LOCAL_PATH');
  }

  // 按需压缩（大于阈值才压）
  if (imageUrl.startsWith('data:')) {
    const base64Part = imageUrl.split(',')[1] || '';
    // base64 长度约等于原始字节 * 4/3
    const approxBytes = base64Part.length * 0.75;
    if (approxBytes > COMPRESS_THRESHOLD) {
      try {
        imageUrl = await compressBase64Image(imageUrl);
      } catch {
        throw new Error('IMAGE_TOO_LARGE');
      }
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VL_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([ctrl.signal, signal])
    : ctrl.signal;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `file: <image>\n## 任务：精准识别图中的所有汉字\n如果是表格或田字格，请按列或行顺序、精准无误地提取出每一个汉字。只输出识别到的文字内容，按原文排版或用空格分隔。不要提供任何额外的解释或词语定义。` },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        max_tokens: 512,   // 原来没限制，加上避免慢输出
        stream: false,
      }),
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`VL API error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[无描述]';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 图片压缩 — 一次性到位，不再多轮重试
 * 500KB+ → resize 到 512px + JPEG 70
 * 仍超限 → resize 到 384px + JPEG 50
 */
async function compressBase64Image(dataUrl) {
  const sharp = (await import('sharp')).default;

  const match = dataUrl.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!match) throw new Error('Invalid data URL format');

  const buffer = Buffer.from(match[2], 'base64');

  // 第一次：512px + quality 70（通常够了）
  const out1 = await sharp(buffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toBuffer();

  const url1 = `data:image/jpeg;base64,${out1.toString('base64')}`;
  if (url1.length <= MAX_BASE64_LENGTH) {
    console.log(`[multimodal] compress: ${(buffer.length / 1024).toFixed(0)}KB → ${(out1.length / 1024).toFixed(0)}KB`);
    return url1;
  }

  // 第二次：384px + quality 50
  const out2 = await sharp(buffer)
    .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 50 })
    .toBuffer();

  const url2 = `data:image/jpeg;base64,${out2.toString('base64')}`;
  if (url2.length <= MAX_BASE64_LENGTH) {
    console.log(`[multimodal] compress (aggressive): ${(buffer.length / 1024).toFixed(0)}KB → ${(out2.length / 1024).toFixed(0)}KB`);
    return url2;
  }

  throw new Error('IMAGE_TOO_LARGE');
}

// ─── 音频转录 ──────────────────────────────────────────────────────────────

async function transcribeAudioInMessages(messages, config, logger, signal) {
  const audioBlocks = [];

  function scan(content, mIdx, path = []) {
    if (!Array.isArray(content)) return;
    content.forEach((block, bIdx) => {
      if (block.type === 'audio' || block.type === 'input_audio') {
        audioBlocks.push({ mIdx, path: [...path, bIdx], block });
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        scan(block.content, mIdx, [...path, bIdx, 'content']);
      }
    });
  }

  messages.forEach((msg, mIdx) => scan(msg.content, mIdx));

  if (audioBlocks.length === 0) return messages;

  logger('info', 'multimodal', 'transcribing_audio', { count: audioBlocks.length });

  const transcriptions = await Promise.all(audioBlocks.map(async ({ block }, index) => {
    try {
      const text = await Promise.race([
        transcribeAudio(block, { ...config, signal }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error('ASR_TIMEOUT')), ASR_TIMEOUT_MS)
        ),
      ]);
      return text;
    } catch (err) {
      if (err.message === 'ASR_TIMEOUT') {
        logger('warn', 'multimodal', `asr_timeout_${index}`);
        return '[语音：转录超时，已跳过]';
      }
      logger('error', 'multimodal', `asr_failed_${index}`, { error: err.message });
      return `[语音转录失败: ${err.message}]`;
    }
  }));

  const newMessages = JSON.parse(JSON.stringify(messages));
  audioBlocks.forEach(({ mIdx, path }, i) => {
    let target = newMessages[mIdx].content;
    for (let j = 0; j < path.length - 1; j++) {
      target = target[path[j]];
    }
    const lastIdx = path[path.length - 1];
    target[lastIdx] = {
      type: 'text',
      text: `[语音内容转录 (SenseVoice)]: ${transcriptions[i]}`,
    };
  });

  newMessages.forEach(msg => {
    if (!Array.isArray(msg.content)) return;
    const combined = [];
    for (const block of msg.content) {
      if (
        block.type === 'text' &&
        combined.length > 0 &&
        combined[combined.length - 1].type === 'text'
      ) {
        combined[combined.length - 1].text += '\n' + block.text;
      } else {
        combined.push(block);
      }
    }
    msg.content = combined.length === 1 && combined[0].type === 'text'
      ? combined[0].text
      : combined;
  });

  return newMessages;
}

export async function transcribeAudio(audioBlock, config) {
  const { apiKey, endpoint, model, signal } = config;

  let base64Data = '';
  if (audioBlock.input_audio?.data) {
    base64Data = audioBlock.input_audio.data;
  } else if (audioBlock.source?.data) {
    base64Data = audioBlock.source.data;
  }

  if (!base64Data) throw new Error('No audio data found');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ASR_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([ctrl.signal, signal])
    : ctrl.signal;

  try {
    const formData = new FormData();
    formData.append('model', model);
    const audioBuffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    formData.append('file', blob, 'audio.wav');

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
      signal: combinedSignal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`ASR API error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    return data.text || '[无转录内容]';
  } finally {
    clearTimeout(timer);
  }
}
