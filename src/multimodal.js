const TIMEOUT_MS = 60000; // 60s timeout for each AI call

/**
 * 处理多模态消息：将图片转化为描述，将语音转化为转录
 * @returns {Promise<{isChanged: boolean, messages: any[]}>}
 */
export async function processMultimodalMessages(messages, visionConfig, audioConfig, logger = console.log, signal = null) {
  const originalJSON = JSON.stringify(messages);
  let processedMessages = JSON.parse(originalJSON);

  // 1. 处理图片 (Vision API)
  if (visionConfig?.apiKey) {
    processedMessages = await describeImagesInMessages(processedMessages, visionConfig, logger, signal);
  }

  // 2. 处理音频 (ASR API)
  if (audioConfig?.apiKey) {
    processedMessages = await transcribeAudioInMessages(processedMessages, audioConfig, logger, signal);
  }

  const isChanged = JSON.stringify(processedMessages) !== originalJSON;
  return { isChanged, messages: processedMessages };
}

async function describeImagesInMessages(messages, config, logger, signal) {
  const { apiKey, endpoint, model, prompt } = config;
  
  // 提取所有待处理的图片块 (包含嵌套在 tool_result 中的)
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

  messages.slice(-10).forEach((msg, mIdx) => scan(msg.content, Math.max(0, messages.length - 10) + mIdx));

  if (imageBlocks.length === 0) return messages;

  logger('info', 'multimodal', 'describing_images', { count: imageBlocks.length });

  const descriptions = await Promise.all(imageBlocks.map(async ({ block }, index) => {
    try {
      const startTime = Date.now();
      const desc = await describeImage(block, { ...config, signal });
      const duration = Date.now() - startTime;
      logger('debug', 'multimodal', `image_description_success_${index}`, { duration });
      return desc;
    } catch (err) {
      if (err.message === 'DETECTED_LOCAL_PATH') {
        const guidance = `[检测到本地图片路径。由于安全限制，代理不会直接读取您的本地文件。建议：1. 请直接将图片拖入终端或点击附件图标上传；2. 或者如果您是开发者，可以使用工具读取该文件并将其内容发给我（但注意非文本文件可能无法直接阅读）。]`;
        logger('warn', 'multimodal', `local_path_guidance_${index}`);
        return guidance;
      }
      if (err.message === 'IMAGE_TOO_LARGE') {
        const guidance = `[图片数据过大，自动压缩后仍超过视觉模型 API 的输入限制。建议：1. 手动裁剪图片只保留关键区域；2. 截图替代完整页面截图。]`;
        logger('warn', 'multimodal', `image_too_large_guidance_${index}`);
        return guidance;
      }
      logger('error', 'multimodal', `image_description_failed_${index}`, { error: err.message });
      return `[图片描述失败: ${err.message}]`;
    }
  }));

  // 回填描述并移除原图
  const newMessages = JSON.parse(JSON.stringify(messages));
  imageBlocks.forEach(({ mIdx, path }, i) => {
    const desc = descriptions[i];
    let target = newMessages[mIdx].content;
    
    // 按路径找到嵌套块
    for (let j = 0; j < path.length - 1; j++) {
      target = target[path[j]];
    }
    
    const lastIdx = path[path.length - 1];
    target[lastIdx] = { type: 'text', text: `[图片内容描述 (Qwen2.5-VL)]: ${desc}` };
  });

  // 合并相邻的文本块
  newMessages.forEach(msg => {
    if (Array.isArray(msg.content)) {
      const combined = [];
      msg.content.forEach(block => {
        if (block.type === 'text' && combined.length > 0 && combined[combined.length - 1].type === 'text') {
          combined[combined.length - 1].text += '\n' + block.text;
        } else {
          combined.push(block);
        }
      });
      if (combined.length === 1 && combined[0].type === 'text') {
        msg.content = combined[0].text;
      } else {
        msg.content = combined;
      }
    }
  });

  return newMessages;
}

async function describeImage(imageBlock, config) {
  const { apiKey, endpoint, model, prompt, signal } = config;
  let imageUrl = '';

  if (imageBlock.type === 'image_url') {
    imageUrl = imageBlock.image_url?.url || '';
  } else if (imageBlock.source?.type === 'base64') {
    imageUrl = `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`;
  } else {
    imageUrl = imageBlock.source?.url || '';
  }

  if (!imageUrl) throw new Error('No image URL or data found');

  // ★ 方案 B 优化：如果是本地路径且没有数据，抛出带有引导信息的错误
  if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
    throw new Error('DETECTED_LOCAL_PATH');
  }

  // ★ 自动压缩：如果 base64 过长，自动压缩图片而非拒绝
  if (imageUrl.startsWith('data:') && imageUrl.length > 100000) {
    try {
      imageUrl = await compressBase64Image(imageUrl);
    } catch (err) {
      // 压缩失败时回退到原始错误
      throw new Error('IMAGE_TOO_LARGE');
    }
  }

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // 如果有外部 signal，使用 AbortSignal.any 组合
  const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        stream: false
      }),
      signal: combinedSignal
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API error (${res.status}): ${err.slice(0, 500)}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '[无描述]';
  } finally {
    clearTimeout(id);
  }
}

/**
 * 压缩 base64 图片：缩放到 max 1024px，转 JPEG 质量 80%
 * 如果压缩后仍超标，逐步降低质量直到满足限制
 * @param {string} dataUrl - data:image/xxx;base64,... 格式
 * @returns {Promise<string>} 压缩后的 data URL
 */
async function compressBase64Image(dataUrl) {
  const sharp = (await import('sharp')).default;

  // 解析 data URL
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!match) throw new Error('Invalid data URL format');

  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');

  const MAX_BASE64_LENGTH = 90000; // 留一些余量 (< 100k)
  const MAX_DIMENSION = 1024;

  // 获取图片元信息
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  let quality = 80;
  let compressed;

  // 逐步降低质量直到满足大小限制
  while (quality >= 20) {
    const pipeline = sharp(buffer);

    // 如果任一边超过 MAX_DIMENSION，按比例缩放
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
    }

    compressed = await pipeline
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    const compressedBase64 = compressed.toString('base64');
    const compressedUrl = `data:image/jpeg;base64,${compressedBase64}`;

    if (compressedUrl.length <= MAX_BASE64_LENGTH) {
      console.log(`[multimodal] Image compressed: ${(buffer.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB (quality=${quality}, ${width}x${height} → max ${MAX_DIMENSION}px)`);
      return compressedUrl;
    }

    quality -= 15; // 逐步降低质量
  }

  // 最后一次尝试：极度压缩 (256px, quality 15)
  compressed = await sharp(buffer)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 15, mozjpeg: true })
    .toBuffer();

  const finalUrl = `data:image/jpeg;base64,${compressed.toString('base64')}`;
  console.log(`[multimodal] Image aggressively compressed: ${(buffer.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB (quality=15, 512px)`);

  if (finalUrl.length > MAX_BASE64_LENGTH) {
    throw new Error('IMAGE_TOO_LARGE'); // 极度压缩后仍然太大
  }

  return finalUrl;
}


async function transcribeAudioInMessages(messages, config, logger, signal) {
  const { apiKey, endpoint, model } = config;
  
  // 提取所有音频块 (包含嵌套的)
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

  messages.slice(-10).forEach((msg, mIdx) => scan(msg.content, Math.max(0, messages.length - 10) + mIdx));

  if (audioBlocks.length === 0) return messages;

  logger('info', 'multimodal', 'transcribing_audio', { count: audioBlocks.length });

  const transcriptions = await Promise.all(audioBlocks.map(async ({ block }, index) => {
    try {
      const startTime = Date.now();
      const text = await transcribeAudio(block, { ...config, signal });
      const duration = Date.now() - startTime;
      logger('debug', 'multimodal', `audio_transcription_success_${index}`, { duration });
      return text;
    } catch (err) {
      logger('error', 'multimodal', `audio_transcription_failed_${index}`, { error: err.message });
      return `[语音转录失败: ${err.message}]`;
    }
  }));

  const newMessages = JSON.parse(JSON.stringify(messages));
  audioBlocks.forEach(({ mIdx, path }, i) => {
    const text = transcriptions[i];
    let target = newMessages[mIdx].content;
    
    for (let j = 0; j < path.length - 1; j++) {
      target = target[path[j]];
    }
    
    const lastIdx = path[path.length - 1];
    target[lastIdx] = { type: 'text', text: `[语音内容转录 (SenseVoice)]: ${text}` };
  });

  // 合并相邻文本
  newMessages.forEach(msg => {
    if (Array.isArray(msg.content)) {
      const combined = [];
      msg.content.forEach(block => {
        if (block.type === 'text' && combined.length > 0 && combined[combined.length - 1].type === 'text') {
          combined[combined.length - 1].text += '\n' + block.text;
        } else {
          combined.push(block);
        }
      });
      if (combined.length === 1 && combined[0].type === 'text') {
        msg.content = combined[0].text;
      } else {
        msg.content = combined;
      }
    }
  });

  return newMessages;
}

async function transcribeAudio(audioBlock, config) {
  const { apiKey, endpoint, model, signal } = config;
  let base64Data = '';
  // OpenAI 格式 input_audio
  if (audioBlock.input_audio?.data) {
    base64Data = audioBlock.input_audio.data;
  } 
  // Anthropic 格式 (假设)
  else if (audioBlock.source?.data) {
    base64Data = audioBlock.source.data;
  }

  if (!base64Data) throw new Error('No audio data found');

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // SiliconFlow /v1/audio/transcriptions 通常要求 multipart/form-data
    // 虽然有些 provider 支持 JSON，但 SF 似乎不行
    const formData = new FormData();
    formData.append('model', model);
    
    // 将 base64 转换为 Blob
    const buffer = Buffer.from(base64Data, 'base64');
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    formData.append('file', blob, 'audio.mp3');

    // 组合外部 signal
    const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
        // 不要手动设置 Content-Type，fetch 会自动设置包含 boundary 的 multipart/form-data
      },
      body: formData,
      signal: combinedSignal
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`ASR API error (${res.status}): ${err.slice(0, 500)}`);
    }

    const data = await res.json();
    return data.text || '[无转录内容]';
  } finally {
    clearTimeout(id);
  }
}
