import fetch from 'node-fetch';

/**
 * tts.js — 语音合成工具类
 */

/**
 * 将文本转换为语音数据 (Buffer)
 * 
 * @param {string} text - 要合成的文本
 * @param {object} config - 配置 { endpoint, apiKey, model, voice }
 * @param {AbortSignal} signal - 中止信号
 * @returns {Promise<Buffer>} - 音频数据内容
 */
export async function synthesize(text, config, signal) {
  const { endpoint, apiKey, model, voice } = config;

  if (!endpoint || !apiKey) {
    throw new Error('TTS configuration missing (endpoint or apiKey)');
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * 句子分割器：根据标点符号将文本流分割成适合合成的短句
 */
export class SentenceSplitter {
  constructor() {
    this.buffer = '';
    // 常见的句子结束符：句号、感叹号、问号、分号（含中英文）
    this.punctuations = /[。！？；.!?;]/;
  }

  /**
   * 推入新的文本片段，返回切割出的完整句子列表
   * @param {string} chunk 
   * @returns {string[]}
   */
  feed(chunk) {
    this.buffer += chunk;
    const sentences = [];
    
    // 循环查找标点符号进行切割
    let match;
    while ((match = this.buffer.match(this.punctuations))) {
      const idx = match.index + 1;
      const sentence = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx);
      if (sentence) sentences.push(sentence);
    }

    return sentences;
  }

  /**
   * 刷新缓冲区，返回剩余的内容（通常在流结束时调用）
   * @returns {string|null}
   */
  flush() {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining || null;
  }
}
