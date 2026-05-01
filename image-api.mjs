import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : existsSync('/.dockerenv') && existsSync('/data') ? '/data' : APP_DIR;

export const DEFAULT_CONFIG = Object.freeze({
  NEWAPI_BASE_URL: 'https://newapi.768696.xyz',
  NEWAPI_API_KEY: '',
  IMAGE_MODEL: 'gpt-image-2',
  IMAGE_SIZE: 'auto',
  IMAGE_QUALITY: process.env.IMAGE_QUALITY || '',
  IMAGE_OUTPUT_FORMAT: process.env.IMAGE_OUTPUT_FORMAT || 'png',
  IMAGE_OUTPUT_COMPRESSION: process.env.IMAGE_OUTPUT_COMPRESSION || '100',
  IMAGE_TIMEOUT_MS: Number(process.env.IMAGE_TIMEOUT_MS || 600000),
});

export const IMAGE_COST_CNY = 0.2;

export const IMAGE_SIZE_OPTIONS = Object.freeze([
  { ratio: 'auto', label: '自动尺寸', value: 'auto', description: '默认推荐；不确定场景时使用，让模型按提示词自动选择。' },
  { ratio: '1:1', label: '正方形 1:1', value: '1024x1024', description: '适合头像、电商主图、朋友圈/社交平台方图。' },
  { ratio: '3:2', label: '电脑/网页横图 3:2', value: '1536x1024', description: '适合电脑封面、网页横幅、横版海报、相机横拍。' },
  { ratio: '2:3', label: '手机/拍照竖图 2:3', value: '1024x1536', description: '适合手机拍照比例、手机壁纸、小红书/竖版海报。' },
]);

export class ImageGenerationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ImageGenerationError';
    Object.assign(this, details);
  }
}

export function isPlaceholderApiKey(value) {
  const apiKey = String(value || '').trim();
  return !apiKey || apiKey === '在这里填写你的key';
}

export function normalizeApiKey(value) {
  return String(value || '').trim().replace(/^Bearer\s+/i, '').trim();
}

export function assertHeaderSafeApiKey(apiKey) {
  for (let index = 0; index < apiKey.length; index += 1) {
    if (apiKey.charCodeAt(index) > 255) {
      throw new ImageGenerationError('API Key 里包含中文或其他非英文字符，请只粘贴纯 key，不要带说明文字。', {
        statusCode: 400,
      });
    }
  }
}

export function countPromptCharacters(prompt) {
  return Array.from(String(prompt || '').replace(/\s/g, '')).length;
}

export function validatePromptLength(prompt, minimumCharacters, label) {
  const count = countPromptCharacters(prompt);
  if (count < minimumCharacters) {
    throw new ImageGenerationError(`${label}提示词至少需要 ${minimumCharacters} 个字，当前约 ${count} 个字。`, {
      statusCode: 400,
    });
  }
}

export function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_CONFIG.NEWAPI_BASE_URL).trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function normalizeSize(value) {
  const size = String(value || DEFAULT_CONFIG.IMAGE_SIZE).trim();
  if (size === 'auto') return size;
  if (!/^\d{2,5}x\d{2,5}$/.test(size)) {
    throw new ImageGenerationError('图片尺寸必须是 1024x1024 这种格式。', { statusCode: 400 });
  }
  return size;
}

export function normalizeOutputFormat(value) {
  const outputFormat = String(value || DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT || 'png').trim().toLowerCase();
  return ['png', 'jpeg', 'jpg', 'webp'].includes(outputFormat)
    ? outputFormat.replace('jpg', 'jpeg')
    : 'png';
}

export function normalizeOutputCompression(value) {
  const rawValue = value ?? DEFAULT_CONFIG.IMAGE_OUTPUT_COMPRESSION;
  if (rawValue === '' || rawValue === null || rawValue === undefined) return null;
  const compression = Number(rawValue);
  if (!Number.isFinite(compression)) return null;
  return Math.max(0, Math.min(100, Math.round(compression)));
}

export function redact(text, secret) {
  if (!secret) return text;
  return String(text).split(secret).join('[redacted-api-key]');
}

export function explainKnownImageError(responseText) {
  if (responseText.includes("Tool choice 'image_generation' not found in 'tools' parameter")) {
    return '请求已经打到网关，但网关返回 image_generation tool_choice 错误；通常是第三方 OpenAI 兼容网关的图片路由或上游通道配置异常。';
  }
  return '';
}

export function createOutputPath(outputName, outputFormat = DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT) {
  const fileName = normalizeOutputFileName(outputName, outputFormat);
  return path.join(PROJECT_DIR, fileName);
}

export async function generateImage(options = {}) {
  const prompt = String(options.prompt || '').trim();
  if (!prompt) {
    throw new ImageGenerationError('请先填写图片提示词。', { statusCode: 400 });
  }
  validatePromptLength(prompt, 15, '从 0 生成图片');

  const apiKey = normalizeApiKey(options.apiKey || DEFAULT_CONFIG.NEWAPI_API_KEY);
  if (isPlaceholderApiKey(apiKey)) {
    throw new ImageGenerationError('未配置 API Key。请让管理员在后台配置图片接口。', {
      statusCode: 400,
    });
  }

  assertHeaderSafeApiKey(apiKey);

  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_CONFIG.NEWAPI_BASE_URL);
  const endpoint = `${baseUrl}/images/generations`;
  const model = String(options.model || DEFAULT_CONFIG.IMAGE_MODEL || 'gpt-image-2').trim();
  const size = normalizeSize(options.size || DEFAULT_CONFIG.IMAGE_SIZE);
  const quality = String(options.quality || DEFAULT_CONFIG.IMAGE_QUALITY || '').trim();
  const outputFormat = normalizeOutputFormat(options.outputFormat);
  const outputCompression = normalizeOutputCompression(options.outputCompression);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CONFIG.IMAGE_TIMEOUT_MS || 600000);
  const outputPath = createOutputPath(options.outputName, outputFormat);

  const requestBody = {
    model,
    prompt,
    n: 1,
    output_format: outputFormat,
    size,
  };

  if (quality && quality !== 'default') {
    requestBody.quality = quality;
  }
  if (outputFormat !== 'png' && outputCompression !== null) {
    requestBody.output_compression = outputCompression;
  }

  const apiStartedAt = Date.now();
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  }, timeoutMs);
  const apiHeadersMs = Date.now() - apiStartedAt;
  const { json, jsonParseMs, responseBodyReadMs, responseBytes } = await parseImageResponse(response, apiKey, '图片生成失败');

  const firstImage = json.data?.[0];
  if (!firstImage) {
    throw new ImageGenerationError('图片接口成功返回，但没有图片数据。', {
      responseText: JSON.stringify(json).slice(0, 4000),
    });
  }

  const imageStartedAt = Date.now();
  const imageBuffer = await readImageBuffer(firstImage, timeoutMs);
  const imageReadMs = Date.now() - imageStartedAt;
  await mkdir(PROJECT_DIR, { recursive: true });
  await writeFile(outputPath, imageBuffer);

  return {
    bytes: imageBuffer.length,
    endpoint,
    fileName: path.basename(outputPath),
    model,
    outputPath,
    outputCompression,
    outputFormat,
    quality,
    size,
    timings: {
      apiHeadersMs,
      apiRequestMs: apiHeadersMs + responseBodyReadMs + jsonParseMs,
      imageReadMs,
      imageSource: firstImage.b64_json ? 'b64_json' : 'url',
      jsonParseMs,
      responseBodyReadMs,
      responseBytes,
    },
    estimatedCostCny: IMAGE_COST_CNY,
    usage: json.usage || null,
  };
}

export async function editImage(options = {}) {
  const prompt = String(options.prompt || '').trim();
  if (!prompt) {
    throw new ImageGenerationError('请先填写图片修改提示词。', { statusCode: 400 });
  }
  validatePromptLength(prompt, 10, '底图修改');

  const apiKey = normalizeApiKey(options.apiKey || DEFAULT_CONFIG.NEWAPI_API_KEY);
  if (isPlaceholderApiKey(apiKey)) {
    throw new ImageGenerationError('未配置 API Key。请让管理员在后台配置图片接口。', {
      statusCode: 400,
    });
  }

  assertHeaderSafeApiKey(apiKey);

  const baseImages = normalizeBaseImages(options);
  if (!baseImages.length) {
    throw new ImageGenerationError('请先选择至少一张底图。', { statusCode: 400 });
  }
  if (baseImages.length > 4) {
    throw new ImageGenerationError('最多只能使用 4 张底图。', { statusCode: 400 });
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_CONFIG.NEWAPI_BASE_URL);
  const endpoint = `${baseUrl}/images/edits`;
  const model = String(options.model || DEFAULT_CONFIG.IMAGE_MODEL || 'gpt-image-2').trim();
  const size = normalizeSize(options.size || DEFAULT_CONFIG.IMAGE_SIZE);
  const quality = String(options.quality || DEFAULT_CONFIG.IMAGE_QUALITY || '').trim();
  const outputFormat = normalizeOutputFormat(options.outputFormat);
  const outputCompression = normalizeOutputCompression(options.outputCompression);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_CONFIG.IMAGE_TIMEOUT_MS || 600000);
  const outputPath = createOutputPath(options.outputName, outputFormat);

  const formData = new FormData();
  formData.append('model', model);
  formData.append('prompt', buildEditPromptWithImageLabels(prompt, baseImages));
  formData.append('n', '1');
  formData.append('output_format', outputFormat);
  formData.append('size', size);

  if (quality && quality !== 'default') {
    formData.append('quality', quality);
  }
  if (outputFormat !== 'png' && outputCompression !== null) {
    formData.append('output_compression', String(outputCompression));
  }

  for (const baseImage of baseImages) {
    formData.append('image[]', new Blob([baseImage.buffer], { type: baseImage.mimeType }), baseImage.fileName);
  }

  const apiStartedAt = Date.now();
  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  }, timeoutMs);
  const apiHeadersMs = Date.now() - apiStartedAt;

  const { json, jsonParseMs, responseBodyReadMs, responseBytes } = await parseImageResponse(response, apiKey, '图片修改失败');
  const firstImage = json.data?.[0];
  if (!firstImage) {
    throw new ImageGenerationError('图片接口成功返回，但没有图片数据。', {
      responseText: JSON.stringify(json).slice(0, 4000),
    });
  }

  const imageStartedAt = Date.now();
  const imageBuffer = await readImageBuffer(firstImage, timeoutMs);
  const imageReadMs = Date.now() - imageStartedAt;
  await mkdir(PROJECT_DIR, { recursive: true });
  await writeFile(outputPath, imageBuffer);

  return {
    bytes: imageBuffer.length,
    endpoint,
    fileName: path.basename(outputPath),
    model,
    outputPath,
    outputCompression,
    outputFormat,
    quality,
    size,
    timings: {
      apiHeadersMs,
      apiRequestMs: apiHeadersMs + responseBodyReadMs + jsonParseMs,
      imageReadMs,
      imageSource: firstImage.b64_json ? 'b64_json' : 'url',
      jsonParseMs,
      responseBodyReadMs,
      responseBytes,
    },
    estimatedCostCny: IMAGE_COST_CNY,
    usage: json.usage || null,
  };
}

function buildEditPromptWithImageLabels(prompt, baseImages) {
  const imageLines = baseImages.map((image, index) => {
    const label = image.label || `图片${index + 1}`;
    return `${label}：${describeBaseImageRole(image.role)}，这是第 ${index + 1} 张输入图片。`;
  });
  return [
    '你会收到多张图片，编号和用途如下；用户提示词里的“图片1/图片2/第一张图/第二张图”必须严格按这里理解：',
    ...imageLines,
    '编辑规则：如果有“需要修改的原始底图/主画布”，必须以它作为最终画布，保留原图的聊天截图版式、文字、昵称、时间、气泡和整体构图，除用户明确要求外不要重画整张图。',
    '如果用户说“把某个头像/牌子/局部换成图片1”，图片1是替换来源或参考图，不是最终画布；只替换指定区域，并让光影、裁切、边缘和透视自然融合。',
    '请严格按上述图片编号执行合成、替换、头像、牌子或局部修改要求。',
    '用户修改要求：',
    prompt,
  ].join('\n');
}

function describeBaseImageRole(role) {
  if (role === 'target') return '需要修改的原始底图/主画布';
  if (role === 'reference') return '参考图/替换来源';
  return '输入底图/参考素材';
}

function normalizeBaseImages(options) {
  if (Array.isArray(options.baseImages)) {
    return options.baseImages.map((image, index) => {
      const fileName = normalizeBaseImageName(image.fileName || `base-image-${index + 1}.png`);
      return {
        buffer: Buffer.isBuffer(image.buffer) ? image.buffer : Buffer.from(image.buffer || []),
        fileName,
        label: normalizeBaseImageLabel(image.label, index),
        mimeType: normalizeImageMimeType(image.mimeType, fileName),
        role: normalizeBaseImageRole(image.role),
      };
    }).filter((image) => image.buffer.length > 0);
  }

  const legacyBuffer = Buffer.isBuffer(options.baseImageBuffer)
    ? options.baseImageBuffer
    : Buffer.from(options.baseImageBuffer || []);
  if (!legacyBuffer.length) return [];
  const fileName = normalizeBaseImageName(options.baseImageName);
  return [{
    buffer: legacyBuffer,
    fileName,
    label: '图片1',
    mimeType: normalizeImageMimeType(options.baseImageType, fileName),
    role: 'target',
  }];
}

function normalizeBaseImageLabel(label, index) {
  const normalized = String(label || '').trim();
  if (/^图片[1-4]$/.test(normalized)) return normalized;
  return `图片${index + 1}`;
}

function normalizeBaseImageRole(role) {
  const normalized = String(role || '').trim();
  return ['target', 'reference', 'input'].includes(normalized) ? normalized : 'input';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseImageResponse(response, apiKey, failurePrefix) {
  const responseBodyStartedAt = Date.now();
  const responseText = await response.text();
  const responseBodyReadMs = Date.now() - responseBodyStartedAt;
  const responseBytes = Buffer.byteLength(responseText);
  if (!response.ok) {
    throw new ImageGenerationError(`${failurePrefix}：HTTP ${response.status}`, {
      statusCode: response.status,
      responseText: redact(responseText, apiKey).slice(0, 4000),
      diagnosis: explainKnownImageError(responseText),
    });
  }

  try {
    const jsonParseStartedAt = Date.now();
    const json = JSON.parse(responseText);
    return {
      json,
      jsonParseMs: Date.now() - jsonParseStartedAt,
      responseBodyReadMs,
      responseBytes,
    };
  } catch (error) {
    throw new ImageGenerationError('图片接口返回了非 JSON 内容。', {
      cause: error,
      responseText: redact(responseText, apiKey).slice(0, 4000),
    });
  }
}

async function readImageBuffer(firstImage, timeoutMs) {
  if (firstImage.b64_json) {
    return Buffer.from(firstImage.b64_json, 'base64');
  }

  if (firstImage.url) {
    const imageResponse = await fetchWithTimeout(firstImage.url, { method: 'GET' }, timeoutMs);
    if (!imageResponse.ok) {
      throw new ImageGenerationError(`下载生成图片失败：HTTP ${imageResponse.status}`, {
        statusCode: imageResponse.status,
      });
    }
    return Buffer.from(await imageResponse.arrayBuffer());
  }

  throw new ImageGenerationError('接口返回的图片格式不支持。', {
    responseText: JSON.stringify(firstImage).slice(0, 4000),
  });
}

function normalizeOutputFileName(outputName, outputFormat = DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT) {
  const extension = extensionForOutputFormat(outputFormat);
  const fallback = `image-${new Date().toISOString().replace(/[:.]/g, '-')}${extension}`;
  const rawName = String(outputName || fallback).trim();
  const baseName = path.basename(rawName) || fallback;
  let safeName = baseName.replace(/[^\p{L}\p{N}._-]+/gu, '-');

  if (!safeName || safeName === '.' || safeName === '..') {
    safeName = fallback;
  }

  if (safeName.startsWith('.')) {
    safeName = `image-${safeName.slice(1)}`;
  }

  if (/\.(png|jpg|jpeg|webp)$/i.test(safeName)) {
    safeName = safeName.replace(/\.(png|jpg|jpeg|webp)$/i, extension);
  } else {
    safeName = `${safeName}${extension}`;
  }

  return safeName;
}

function extensionForOutputFormat(outputFormat) {
  return normalizeOutputFormat(outputFormat) === 'jpeg' ? '.jpg' : `.${normalizeOutputFormat(outputFormat)}`;
}

function normalizeBaseImageName(baseImageName) {
  const fileName = path.basename(String(baseImageName || 'base-image.png').trim()) || 'base-image.png';
  return /\.(png|jpg|jpeg|webp|heic|heif)$/i.test(fileName) ? fileName : `${fileName}.png`;
}

function normalizeImageMimeType(value, fileName) {
  const mimeType = String(value || '').trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  if (['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'].includes(mimeType)) {
    return mimeType;
  }

  const extension = path.extname(fileName).toLowerCase();
  const mimeFromExtension = {
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension];

  if (mimeFromExtension) {
    return mimeFromExtension;
  }

  throw new ImageGenerationError('底图只支持 PNG、JPG/JPEG、WEBP、HEIC/HEIF 格式。', { statusCode: 400 });
}
