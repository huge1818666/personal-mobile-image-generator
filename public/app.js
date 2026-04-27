const loginView = document.querySelector('#loginView');
const appView = document.querySelector('#appView');
const loginForm = document.querySelector('#loginForm');
const loginButton = document.querySelector('#loginButton');
const loginStatus = document.querySelector('#loginStatus');
const logoutButton = document.querySelector('#logoutButton');
const currentUser = document.querySelector('#currentUser');
const appVersion = document.querySelector('#appVersion');
const generateForm = document.querySelector('#generateForm');
const promptInput = document.querySelector('#prompt');
const clearPromptButton = document.querySelector('#clearPromptButton');
const promptRule = document.querySelector('#promptRule');
const promptMeta = document.querySelector('#promptMeta');
const promptExamples = document.querySelector('#promptExamples');
const baseImageFile = document.querySelector('#baseImageFile');
const baseImageInfo = document.querySelector('#baseImageInfo');
const baseImageList = document.querySelector('#baseImageList');
const clearBaseButton = document.querySelector('#clearBaseButton');
const sizeOptions = document.querySelector('#sizeOptions');
const qualityInput = document.querySelector('#quality');
const outputFormatInput = document.querySelector('#outputFormat');
const outputCompressionInput = document.querySelector('#outputCompression');
const apiKeyInput = document.querySelector('#apiKey');
const baseUrlInput = document.querySelector('#baseUrl');
const modelInput = document.querySelector('#model');
const statusBox = document.querySelector('#statusBox');
const generateButton = document.querySelector('#generateButton');
const costNote = document.querySelector('#costNote');
const preview = document.querySelector('#preview');
const resultMeta = document.querySelector('#resultMeta');
const downloadButton = document.querySelector('#downloadButton');
const useResultAsBaseButton = document.querySelector('#useResultAsBaseButton');
const refreshJobsButton = document.querySelector('#refreshJobsButton');
const refreshImagesButton = document.querySelector('#refreshImagesButton');
const jobList = document.querySelector('#jobList');
const imageList = document.querySelector('#imageList');
const adminPanel = document.querySelector('#adminPanel');
const refreshUsersButton = document.querySelector('#refreshUsersButton');
const userForm = document.querySelector('#userForm');
const userFormTitle = document.querySelector('#userFormTitle');
const managedUserIdInput = document.querySelector('#managedUserId');
const managedUsernameInput = document.querySelector('#managedUsername');
const managedPasswordInput = document.querySelector('#managedPassword');
const managedRoleInput = document.querySelector('#managedRole');
const managedActiveInput = document.querySelector('#managedActive');
const cancelUserEditButton = document.querySelector('#cancelUserEditButton');
const saveUserButton = document.querySelector('#saveUserButton');
const userStatus = document.querySelector('#userStatus');
const userList = document.querySelector('#userList');
const adminApiSettings = [...document.querySelectorAll('[data-admin-api-setting]')];

const settingsKey = 'personal-mobile-image-settings-v2';
const legacySettingsKey = 'personal-mobile-image-settings-v1';
const GENERATE_MIN_PROMPT_CHARACTERS = 15;
const EDIT_MIN_PROMPT_CHARACTERS = 10;
const UPLOAD_IMAGE_TARGET_BYTES = 4 * 1024 * 1024;
const UPLOAD_IMAGE_CONVERSION_OPTIONS = Object.freeze([
  { maxEdge: 1800, quality: 0.88 },
  { maxEdge: 1600, quality: 0.82 },
  { maxEdge: 1400, quality: 0.76 },
  { maxEdge: 1200, quality: 0.7 },
]);
const supportedInputMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const supportedInputExtensionTypes = new Map([
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const fallbackExamples = [
  {
    title: '手机竖版活动图',
    prompt: '生成一张适合手机竖屏浏览的个人活动图，突出主题、时间和行动提示，画面干净高级，文字区域清晰，适合发朋友圈或社群。',
  },
  {
    title: '商品实拍优化',
    prompt: '基于底图修改：保留商品主体、真实颜色和关键结构，替换为更干净的浅色背景，增强光影质感，让画面像自然手机实拍。',
  },
  {
    title: '生活方式配图',
    prompt: '生成一张自然真实的生活方式配图，画面有日常使用场景、柔和自然光、干净构图和轻微景深，适合个人分享。',
  },
  {
    title: '头像氛围图',
    prompt: '生成一张适合做头像或主页封面的方形氛围图，主体清晰，背景简洁，有温暖可信的视觉感觉，不要出现复杂文字。',
  },
  {
    title: '底图质感增强',
    prompt: '基于底图修改：不要改变主体结构，只提升画面清晰度、细节质感、光线和整体干净程度，让图片更适合手机屏幕查看。',
  },
];

let defaults = null;
let currentSession = null;
let baseImages = [];
let currentResult = null;
let activeJobId = null;
let jobPollTimer = null;
let selectedSize = 'auto';
let estimatedCostCny = 0.2;
let managedUsers = [];

init().catch((error) => {
  showLogin();
  showLoginStatus(error.message, 'error');
});

async function init() {
  const session = await fetchJson('/api/session', {}, { allowUnauthorized: true });
  if (session.authenticated) {
    await showApp(session);
  } else {
    showLogin();
  }
}

async function showApp(session) {
  currentSession = session;
  loginView.hidden = true;
  appView.hidden = false;
  const roleLabel = session.role === 'admin' ? '管理员' : '普通用户';
  currentUser.textContent = `${session.username || '-'} · ${roleLabel}`;
  appVersion.textContent = formatVersionLabel(session);
  updateAdminVisibility();
  await loadConfig();
  await refreshDashboard();
  if (isAdminSession()) await refreshUsers();
}

function showLogin() {
  stopJobPolling();
  currentSession = null;
  appView.hidden = true;
  loginView.hidden = false;
  updateAdminVisibility();
  loginButton.disabled = false;
}

async function loadConfig() {
  defaults = await fetchJson('/api/config');
  estimatedCostCny = Number(defaults.estimatedCostCny || 0.2);
  appVersion.textContent = formatVersionLabel(defaults) || appVersion.textContent;
  costNote.textContent = `预计消耗 ${formatMoney(estimatedCostCny)} 元`;
  const systemSettings = defaults.systemSettings || {};
  if (canCustomizeApi()) {
    baseUrlInput.value = systemSettings.baseUrl || baseUrlInput.value;
    modelInput.value = systemSettings.model || modelInput.value;
  } else {
    apiKeyInput.value = '';
    baseUrlInput.value = '';
    modelInput.value = '';
  }
  renderSizeOptions(defaults.sizes || []);
  renderPromptExamples(fallbackExamples);
  loadSettings();
  updateOutputCompressionState();
  updateBaseImages();
  updatePromptRule();
}

function renderSizeOptions(sizes) {
  const fallbackSizes = [
    { label: '竖图', value: '1024x1536' },
    { label: '方图', value: '1024x1024' },
    { label: '横图', value: '1536x1024' },
    { label: '自动', value: 'auto' },
  ];
  const preferred = ['auto', '1024x1536', '1024x1024', '1536x1024'];
  const normalized = [
    ...sizes.map((size) => ({ label: shortSizeLabel(size), value: size.value })),
    ...fallbackSizes,
  ].filter((size, index, all) => (
    size.value && all.findIndex((item) => item.value === size.value) === index
  )).sort((a, b) => rankSize(a.value, preferred) - rankSize(b.value, preferred));

  sizeOptions.innerHTML = normalized.map((size) => `
    <button type="button" data-size="${escapeAttribute(size.value)}">${escapeHtml(size.label)}</button>
  `).join('');

  sizeOptions.querySelectorAll('[data-size]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedSize = button.dataset.size || 'auto';
      updateSizeButtons();
      saveSettings();
    });
  });
}

function rankSize(value, preferred) {
  const index = preferred.indexOf(value);
  return index >= 0 ? index : 99;
}

function shortSizeLabel(size) {
  if (size.value === 'auto') return '自动';
  if (size.value === '1024x1536') return '竖图';
  if (size.value === '1024x1024') return '方图';
  if (size.value === '1536x1024') return '横图';
  return size.label || size.value;
}

function renderPromptExamples(examples) {
  promptExamples.innerHTML = examples.map((example) => `
    <button type="button" data-prompt="${escapeAttribute(example.prompt || '')}">
      ${escapeHtml(example.title || '提示词')}
    </button>
  `).join('');

  promptExamples.querySelectorAll('[data-prompt]').forEach((button) => {
    button.addEventListener('click', () => {
      promptInput.value = button.dataset.prompt || '';
      updatePromptRule();
      saveSettings();
      showStatus('已填入案例，可继续微调。', 'success');
    });
  });
}

function loadSettings() {
  const saved = readSettings();
  promptInput.value = saved.prompt || promptInput.value;
  selectedSize = saved.size || defaults.size || selectedSize;
  qualityInput.value = saved.quality || defaults.quality || 'default';
  outputFormatInput.value = saved.outputFormat || defaults.outputFormat || 'png';
  outputCompressionInput.value = saved.outputCompression ?? defaults.outputCompression ?? '100';
  if (canCustomizeApi()) {
    baseUrlInput.value = saved.baseUrl || baseUrlInput.value;
    modelInput.value = saved.model || modelInput.value;
  }
  updateSizeButtons();
}

function readSettings() {
  try {
    const saved = localStorage.getItem(settingsKey);
    const value = JSON.parse(saved || localStorage.getItem(legacySettingsKey) || '{}');
    if (!saved && value?.size === '1024x1536') value.size = 'auto';
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const settings = {
    outputCompression: outputCompressionInput.value,
    outputFormat: outputFormatInput.value,
    prompt: promptInput.value.trim(),
    quality: qualityInput.value,
    size: selectedSize,
  };
  if (canCustomizeApi()) {
    settings.baseUrl = baseUrlInput.value.trim();
    settings.model = modelInput.value.trim();
  }
  localStorage.setItem(settingsKey, JSON.stringify(settings));
}

function updateAdminVisibility() {
  const admin = isAdminSession();
  adminApiSettings.forEach((element) => {
    element.hidden = !admin;
  });
  adminPanel.hidden = !admin;
  if (admin && !managedUserIdInput.value) resetUserForm();
  if (!admin) {
    managedUsers = [];
    userList.innerHTML = '';
    resetUserForm();
  }
}

function updateSizeButtons() {
  sizeOptions.querySelectorAll('[data-size]').forEach((button) => {
    button.classList.toggle('active', button.dataset.size === selectedSize);
  });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  showLoginStatus('正在登录...', '');
  try {
    const result = await fetchJson('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: document.querySelector('#loginPassword').value,
        username: document.querySelector('#loginUsername').value.trim(),
      }),
    }, { allowUnauthorized: true });
    showLoginStatus('登录成功。', 'success');
    await showApp(result);
  } catch (error) {
    showLoginStatus(error.message, 'error');
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  await fetchJson('/api/logout', { method: 'POST' }, { allowUnauthorized: true });
  showLogin();
  showLoginStatus('已退出登录。', '');
});

generateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    validatePrompt();
  } catch (error) {
    showStatus(error.message, 'error');
    return;
  }

  const isEditing = baseImages.length > 0;
  const message = `本次${isEditing ? '修改' : '生成'}预计消耗 ${formatMoney(estimatedCostCny)} 元${isEditing ? '，底图修改可能需要 5-10 分钟' : ''}，确认继续吗？`;
  if (!window.confirm(message)) {
    showStatus('已取消本次任务。', '');
    return;
  }

  generateButton.disabled = true;
  showStatus(isEditing ? '正在提交底图修改任务...' : '正在提交图片生成任务...', '');
  try {
    const payload = {
      outputCompression: outputCompressionInput.value,
      outputFormat: outputFormatInput.value,
      prompt: promptInput.value.trim(),
      quality: qualityInput.value,
      size: selectedSize,
    };
    if (canCustomizeApi()) {
      payload.apiKey = apiKeyInput.value.trim();
      payload.baseUrl = baseUrlInput.value.trim();
      payload.model = modelInput.value.trim();
    }
    if (isEditing) Object.assign(payload, serializeBaseImages());
    const result = await fetchJson(isEditing ? '/api/edit' : '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    saveSettings();
    activeJobId = result.jobId || result.job?.id || null;
    currentResult = null;
    updateResultActions(null);
    preview.innerHTML = '<span>任务已提交</span>';
    resultMeta.textContent = `任务编号：${activeJobId || '-'}`;
    showStatus('任务已提交，完成后会自动显示结果。', 'success');
    await refreshJobs();
    startJobPolling();
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    generateButton.disabled = false;
  }
});

promptInput.addEventListener('input', () => {
  updatePromptRule();
  saveSettings();
});

clearPromptButton.addEventListener('click', () => {
  promptInput.value = '';
  updatePromptRule();
  saveSettings();
  promptInput.focus();
});

baseImageFile.addEventListener('change', () => {
  addIncomingFiles([...(baseImageFile.files || [])]).catch((error) => showStatus(error.message, 'error'));
});

document.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files || [])].filter((file) => getSupportedImageMimeType(file));
  if (!files.length) return;
  event.preventDefault();
  addIncomingFiles(files).catch((error) => showStatus(error.message, 'error'));
});

clearBaseButton.addEventListener('click', () => {
  baseImages = [];
  updateBaseImages();
  updatePromptRule();
  showStatus('已清除底图。', '');
});

qualityInput.addEventListener('change', saveSettings);
outputCompressionInput.addEventListener('input', saveSettings);
outputFormatInput.addEventListener('change', () => {
  updateOutputCompressionState();
  saveSettings();
});
baseUrlInput.addEventListener('input', saveSettings);
modelInput.addEventListener('input', saveSettings);

useResultAsBaseButton.addEventListener('click', () => {
  if (!currentResult) return;
  setGeneratedAsBase(currentResult);
  showStatus('已把当前结果设为底图。', 'success');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

refreshJobsButton.addEventListener('click', () => refreshJobs().catch((error) => showStatus(error.message, 'error')));
refreshImagesButton.addEventListener('click', () => refreshImages().catch((error) => showStatus(error.message, 'error')));
refreshUsersButton.addEventListener('click', () => refreshUsers().catch((error) => showUserStatus(error.message, 'error')));

cancelUserEditButton.addEventListener('click', () => {
  resetUserForm();
  showUserStatus('已取消修改。', '');
});

userForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!isAdminSession()) return;

  const editingUserId = managedUserIdInput.value.trim();
  const payload = {
    active: managedActiveInput.checked,
    password: managedPasswordInput.value,
    role: managedRoleInput.value,
    username: managedUsernameInput.value.trim(),
  };
  saveUserButton.disabled = true;
  showUserStatus(editingUserId ? '正在保存修改...' : '正在新增用户...', '');
  try {
    await fetchJson(editingUserId ? `/api/admin/users/${encodeURIComponent(editingUserId)}` : '/api/admin/users', {
      method: editingUserId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    resetUserForm();
    await refreshUsers();
    showUserStatus(editingUserId ? '用户已更新。' : '用户已新增。', 'success');
  } catch (error) {
    showUserStatus(error.message, 'error');
  } finally {
    saveUserButton.disabled = false;
  }
});

async function addIncomingFiles(files) {
  if (!files.length) return;
  const maxImages = Number(defaults?.maxBaseImages || 4);
  if (baseImages.length + files.length > maxImages) {
    throw new Error(`最多只能使用 ${maxImages} 张底图。`);
  }
  const uploaded = [];
  showStatus('正在上传并处理底图...', '');
  for (const file of files) {
    const mimeType = getSupportedImageMimeType(file);
    if (!mimeType) {
      throw new Error('上传底图只支持 PNG、JPG/JPEG、WEBP、HEIC/HEIF 格式。');
    }
    const preparedImage = await prepareUploadedImage(file, mimeType);
    const { upload } = await uploadBaseImage(preparedImage);
    uploaded.push({
      fileName: upload.originalFileName || preparedImage.fileName,
      imageUrl: upload.imageUrl || '',
      kind: 'upload',
      role: baseImages.some((image) => image.role === 'target') ? 'reference' : 'target',
      size: upload.size || preparedImage.blob.size,
      uploadId: upload.id,
    });
  }
  baseImages = [...baseImages, ...uploaded];
  baseImageFile.value = '';
  updateBaseImages();
  updatePromptRule();
  showStatus(`已上传 ${uploaded.length} 张图片。`, 'success');
}

function setGeneratedAsBase(result) {
  const references = baseImages
    .filter((image) => image.kind !== 'generated')
    .map((image) => ({ ...image, role: 'reference' }))
    .slice(0, Math.max(0, Number(defaults?.maxBaseImages || 4) - 1));
  baseImages = [
    ...references,
    {
      fileName: result.fileName,
      imageUrl: result.imageUrl,
      kind: 'generated',
      role: 'target',
    },
  ];
  updateBaseImages();
  updatePromptRule();
}

function updateBaseImages() {
  clearBaseButton.disabled = !baseImages.length;
  generateButton.textContent = baseImages.length ? '用底图修改' : '生成图片';
  baseImageInfo.textContent = baseImages.length
    ? `已选择 ${baseImages.length} 张图片，可在提示词里写图片1、图片2。`
    : '未选择底图，当前会直接生成新图片。';
  if (!baseImages.length) {
    baseImageList.hidden = true;
    baseImageList.innerHTML = '';
    return;
  }
  baseImageList.hidden = false;
  baseImageList.innerHTML = baseImages.map((image, index) => `
    <article class="base-image-item">
      <button type="button" class="remove-base-image" data-remove-base-image="${index}" aria-label="删除图片${index + 1}">×</button>
      ${image.imageUrl ? `<img src="${escapeAttribute(image.imageUrl)}" alt="图片${index + 1}">` : `<div class="base-image-placeholder">HEIC</div>`}
      <span>图片${index + 1} · ${escapeHtml(describeBaseImage(image))}</span>
    </article>
  `).join('');
  baseImageList.querySelectorAll('[data-remove-base-image]').forEach((button) => {
    button.addEventListener('click', () => {
      baseImages.splice(Number(button.dataset.removeBaseImage), 1);
      updateBaseImages();
      updatePromptRule();
    });
  });
}

function describeBaseImage(image) {
  if (image.role === 'target') return '需要修改';
  if (image.kind === 'generated') return '生成结果';
  return image.role === 'reference' ? '参考图' : '上传图';
}

function serializeBaseImages() {
  return {
    baseImages: baseImages.map((image, index) => {
      const baseImageLabel = `图片${index + 1}`;
      if (image.kind === 'generated') {
        return {
          baseFileName: image.fileName,
          baseImageLabel,
          baseImageRole: image.role || 'target',
        };
      }
      if (image.uploadId) {
        return {
          baseUploadId: image.uploadId,
          baseImageLabel,
          baseImageRole: image.role || 'target',
        };
      }
      return {
        baseImageData: image.dataUrl,
        baseImageName: image.fileName,
        baseImageLabel,
        baseImageRole: image.role || 'target',
      };
    }),
  };
}

function validatePrompt() {
  const minimum = baseImages.length ? EDIT_MIN_PROMPT_CHARACTERS : GENERATE_MIN_PROMPT_CHARACTERS;
  const count = countPromptCharacters(promptInput.value);
  if (count < minimum) {
    throw new Error(`${baseImages.length ? '底图修改' : '从 0 生成'}提示词至少 ${minimum} 个字，当前约 ${count} 个字。`);
  }
}

function updatePromptRule() {
  const minimum = baseImages.length ? EDIT_MIN_PROMPT_CHARACTERS : GENERATE_MIN_PROMPT_CHARACTERS;
  const count = countPromptCharacters(promptInput.value);
  promptRule.textContent = `${baseImages.length ? '底图修改' : '从 0 生成'}至少 ${minimum} 个字，当前约 ${count} 个字。`;
  promptMeta.classList.toggle('warning', count > 0 && count < minimum);
}

function getSupportedImageMimeType(file) {
  const mimeType = String(file.type || '').toLowerCase();
  if (supportedInputMimeTypes.has(mimeType)) return mimeType;
  const fileName = String(file.name || '').toLowerCase();
  const extension = fileName.match(/\.[^.]+$/)?.[0] || '';
  return supportedInputExtensionTypes.get(extension) || '';
}

async function prepareUploadedImage(file, mimeType) {
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    return readOriginalImageFile(file, mimeType);
  }

  try {
    const converted = await convertImageFileToJpeg(file);
    if (converted) return converted;
  } catch (error) {
    if (mimeType !== 'image/heic' && mimeType !== 'image/heif' && file.size <= UPLOAD_IMAGE_TARGET_BYTES) {
      return readOriginalImageFile(file, mimeType);
    }
    if (mimeType !== 'image/heic' && mimeType !== 'image/heif') {
      throw new Error(`这张图片较大，手机浏览器压缩失败：${error.message || '请换一张小图后重试。'}`);
    }
  }
  return readOriginalImageFile(file, mimeType);
}

async function readOriginalImageFile(file, mimeType) {
  return {
    blob: file,
    chunked: isHeicMimeType(mimeType),
    fileName: normalizeUploadFileName(file.name, extensionForMimeType(mimeType)),
    mimeType,
  };
}

async function convertImageFileToJpeg(file) {
  const image = await decodeImageFile(file);
  let best = null;

  for (const option of UPLOAD_IMAGE_CONVERSION_OPTIONS) {
    const canvas = drawImageToCanvas(image, option.maxEdge);
    const blob = await canvasToBlob(canvas, 'image/jpeg', option.quality);
    best = blob;
    if (blob.size <= UPLOAD_IMAGE_TARGET_BYTES) break;
  }

  if (!best) return null;
  return {
    blob: best,
    fileName: normalizeUploadFileName(file.name, '.jpg'),
    mimeType: 'image/jpeg',
  };
}

async function uploadBaseImage(image) {
  if (image.chunked) return uploadBaseImageInChunks(image);

  return fetchJson('/api/uploads', {
    method: 'POST',
    headers: {
      'Content-Type': image.mimeType,
      'X-File-Name': encodeURIComponent(image.fileName || `upload-${Date.now()}`),
    },
    body: image.blob,
  });
}

async function uploadBaseImageInChunks(image) {
  const start = await fetchJson('/api/uploads/chunk/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: image.fileName,
      mimeType: image.mimeType,
      size: image.blob.size,
    }),
  });

  const chunkSize = Number(start.chunkSize || 384 * 1024);
  const total = Math.ceil(image.blob.size / chunkSize);
  for (let index = 0; index < total; index += 1) {
    const offset = index * chunkSize;
    const chunk = image.blob.slice(offset, Math.min(offset + chunkSize, image.blob.size));
    showStatus(`正在上传 HEIC 底图 ${index + 1}/${total}...`, '');
    await fetchJson(`/api/uploads/chunk/${encodeURIComponent(start.uploadId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: await blobToBase64(chunk),
        index,
        total,
      }),
    });
  }

  showStatus('正在转换 HEIC 底图...', '');
  return fetchJson(`/api/uploads/chunk/${encodeURIComponent(start.uploadId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ total }),
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取上传分片失败。'));
    reader.readAsDataURL(blob);
  });
}

async function decodeImageFile(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to HTMLImageElement decoding for mobile Safari compatibility.
    }
  }

  const imageUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取这张图片。'));
      image.src = imageUrl;
    });
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}

function drawImageToCanvas(image, maxEdge) {
  const sourceWidth = Number(image.width || 0);
  const sourceHeight = Number(image.height || 0);
  if (!sourceWidth || !sourceHeight) throw new Error('图片尺寸异常。');
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持图片压缩。');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片压缩失败。'));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

function normalizeUploadFileName(fileName, extension) {
  const baseName = String(fileName || `upload-${Date.now()}`).replace(/\.[^.]+$/, '');
  return `${baseName || `upload-${Date.now()}`}${extension}`;
}

function extensionForMimeType(mimeType) {
  return {
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  }[mimeType] || '.jpg';
}

function updateOutputCompressionState() {
  outputCompressionInput.disabled = outputFormatInput.value === 'png';
}

async function refreshDashboard() {
  await refreshJobs();
  await refreshImages();
}

async function refreshJobs() {
  const { jobs } = await fetchJson('/api/jobs');
  renderJobs(jobs || []);
  const activeJob = (jobs || []).find((job) => ['queued', 'running'].includes(job.status));
  const trackedJob = (jobs || []).find((job) => job.id === activeJobId) || activeJob;
  if (trackedJob) handleTrackedJob(trackedJob);
  if (activeJob) {
    if (!activeJobId) activeJobId = activeJob.id;
    startJobPolling();
  } else {
    stopJobPolling();
  }
}

function renderJobs(jobs) {
  if (!jobs.length) {
    jobList.innerHTML = '<p class="notice">当前没有图片任务。</p>';
    return;
  }
  jobList.innerHTML = jobs.map((job) => {
    const result = job.result || {};
    const hasResult = job.status === 'done' && result.imageUrl;
    return `
      <article class="job-item ${escapeAttribute(job.status || '')}">
        <div class="job-main">
          <div class="job-title">
            <strong>${job.mode === 'edit' ? '底图修改' : '直接生成'}</strong>
            <span>${formatJobStatus(job.status)}</span>
          </div>
          <p>${escapeHtml(job.prompt || '')}</p>
          <small>${job.ownerUsername ? `${escapeHtml(job.ownerUsername)} · ` : ''}${formatDateTime(job.createdAt)} · ${escapeHtml(job.size || 'auto')}</small>
          <small>${escapeHtml(job.error || getJobDetail(job))}</small>
        </div>
        ${hasResult ? `
          <div class="job-result">
            <img src="${escapeAttribute(result.imageUrl)}?t=${encodeURIComponent(job.updatedAt || '')}" alt="任务结果">
            <button type="button" class="soft-button small" data-preview-job="${escapeAttribute(job.id)}">查看</button>
          </div>
        ` : ''}
      </article>
    `;
  }).join('');

  jobList.querySelectorAll('[data-preview-job]').forEach((button) => {
    button.addEventListener('click', () => {
      const job = jobs.find((item) => item.id === button.dataset.previewJob);
      if (job?.result) showJobResult(job);
    });
  });
}

function handleTrackedJob(job) {
  if (['queued', 'running'].includes(job.status)) {
    showStatus(job.mode === 'edit' ? '图片修改中，通常需要 5-10 分钟。' : '图片生成中。', '');
    return;
  }
  if (job.status === 'done' && job.result) {
    showJobResult(job);
    showStatus(job.mode === 'edit' ? '修改成功。' : '生成成功。', 'success');
    activeJobId = null;
    refreshImages().catch(() => {});
    return;
  }
  if (job.status === 'error') {
    showStatus(job.error || '任务失败，请检查参数后重试。', 'error');
    activeJobId = null;
  }
}

function showJobResult(job) {
  currentResult = job.result;
  preview.innerHTML = `
    <a href="${escapeAttribute(job.result.imageUrl)}" target="_blank" rel="noreferrer">
      <img src="${escapeAttribute(job.result.imageUrl)}?t=${Date.now()}" alt="生成图片">
    </a>
  `;
  resultMeta.textContent = `${job.mode === 'edit' ? '底图修改' : '直接生成'} · ${job.result.size || job.size || 'auto'} · ${formatDateTime(job.finishedAt || job.updatedAt)}`;
  updateResultActions(job.result);
}

function updateResultActions(result) {
  if (!result) {
    downloadButton.classList.add('disabled');
    downloadButton.removeAttribute('href');
    downloadButton.removeAttribute('download');
    downloadButton.setAttribute('aria-disabled', 'true');
    useResultAsBaseButton.disabled = true;
    return;
  }
  downloadButton.classList.remove('disabled');
  downloadButton.href = result.imageUrl;
  downloadButton.download = result.fileName || 'image.png';
  downloadButton.setAttribute('aria-disabled', 'false');
  useResultAsBaseButton.disabled = false;
}

async function refreshImages() {
  const { images } = await fetchJson('/api/images');
  if (!images.length) {
    imageList.innerHTML = '<p class="notice">还没有生成图片。</p>';
    return;
  }
  imageList.innerHTML = images.map((image) => `
    <article class="image-item">
      <a href="${escapeAttribute(image.imageUrl)}" target="_blank" rel="noreferrer">
        <img src="${escapeAttribute(image.imageUrl)}?t=${encodeURIComponent(image.modifiedAt || '')}" alt="生成图片">
      </a>
      <div>
        <span>${formatBytes(image.size)} · ${formatDateTime(image.modifiedAt)}</span>
        <button type="button" class="soft-button small" data-history-base="${escapeAttribute(image.fileName)}" data-image-url="${escapeAttribute(image.imageUrl)}">作底图</button>
      </div>
    </article>
  `).join('');
  imageList.querySelectorAll('[data-history-base]').forEach((button) => {
    button.addEventListener('click', () => {
      setGeneratedAsBase({
        fileName: button.dataset.historyBase,
        imageUrl: button.dataset.imageUrl,
      });
      showStatus('已把历史图片设为底图。', 'success');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

async function refreshUsers() {
  if (!isAdminSession()) return;
  const { users } = await fetchJson('/api/admin/users');
  managedUsers = users || [];
  renderUsers();
}

function renderUsers() {
  if (!managedUsers.length) {
    userList.innerHTML = '<p class="notice">当前没有用户。</p>';
    return;
  }

  userList.innerHTML = managedUsers.map((user) => `
    <article class="user-item">
      <div class="user-main">
        <div class="user-title">
          <strong>${escapeHtml(user.username || '-')}</strong>
          <span class="role-pill">${user.role === 'admin' ? '管理员' : '普通用户'}</span>
          <span class="role-pill ${user.active ? '' : 'off'}">${user.active ? '启用' : '停用'}</span>
        </div>
        <small>${user.source === 'env' ? '环境变量管理员' : `更新于 ${formatDateTime(user.updatedAt || user.createdAt)}`}</small>
      </div>
      ${user.canEdit ? `<button type="button" class="soft-button small" data-edit-user="${escapeAttribute(user.id)}">修改</button>` : ''}
    </article>
  `).join('');

  userList.querySelectorAll('[data-edit-user]').forEach((button) => {
    button.addEventListener('click', () => {
      const user = managedUsers.find((item) => item.id === button.dataset.editUser);
      if (user) editUser(user);
    });
  });
}

function editUser(user) {
  managedUserIdInput.value = user.id || '';
  managedUsernameInput.value = user.username || '';
  managedPasswordInput.value = '';
  managedPasswordInput.required = false;
  managedPasswordInput.placeholder = '留空则不修改密码';
  managedRoleInput.value = user.role || 'user';
  managedActiveInput.checked = user.active !== false;
  userFormTitle.textContent = '修改用户';
  cancelUserEditButton.hidden = false;
  managedUsernameInput.focus();
}

function resetUserForm() {
  if (!userForm) return;
  managedUserIdInput.value = '';
  managedUsernameInput.value = '';
  managedPasswordInput.value = '';
  managedPasswordInput.required = true;
  managedPasswordInput.placeholder = '至少 6 位密码';
  managedRoleInput.value = 'user';
  managedActiveInput.checked = true;
  userFormTitle.textContent = '新增用户';
  cancelUserEditButton.hidden = true;
}

function startJobPolling() {
  if (jobPollTimer) return;
  jobPollTimer = setInterval(() => {
    refreshJobs().catch((error) => showStatus(error.message, 'error'));
  }, 5000);
}

function stopJobPolling() {
  if (jobPollTimer) clearInterval(jobPollTimer);
  jobPollTimer = null;
}

function getJobDetail(job) {
  if (job.elapsedMs) return `耗时 ${formatDuration(job.elapsedMs)}`;
  if (job.status === 'queued') return '等待中';
  if (job.status === 'running') return '后台处理中';
  return '';
}

async function fetchJson(url, options = {}, behavior = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options });
  } catch (error) {
    throw new Error(`网络请求失败：${error.message || '请检查网络连接，或换一张小一点的图片后重试。'}`);
  }
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`服务返回了非 JSON 内容：${text.slice(0, 200)}`);
  }
  if (response.status === 401 && !behavior.allowUnauthorized) showLogin();
  if (!response.ok) {
    throw new Error([json.error, json.diagnosis, json.responseText].filter(Boolean).join('\n') || `请求失败：HTTP ${response.status}`);
  }
  return json;
}

function showStatus(message, type) {
  const text = String(message || '').trim();
  statusBox.className = `notice ${type || ''}`.trim();
  statusBox.textContent = text;
  statusBox.hidden = !text;
}

function showLoginStatus(message, type) {
  loginStatus.className = `notice ${type || ''}`.trim();
  loginStatus.textContent = message;
}

function formatVersionLabel(info) {
  const app = info?.version || info?.appVersion || 'personal-v0.1.0';
  const web = info?.webVersion || 'web-v0.1.2';
  return `${app} · ${web}`;
}

function showUserStatus(message, type) {
  const text = String(message || '').trim();
  userStatus.className = `notice ${type || ''}`.trim();
  userStatus.textContent = text;
  userStatus.hidden = !text;
}

function isAdminSession() {
  return currentSession?.role === 'admin';
}

function canCustomizeApi() {
  return Boolean(defaults?.canCustomizeApi && isAdminSession());
}

function countPromptCharacters(value) {
  return Array.from(String(value || '').replace(/\s/g, '')).length;
}

function isHeicMimeType(mimeType) {
  return mimeType === 'image/heic' || mimeType === 'image/heif';
}

function formatJobStatus(status) {
  const labels = {
    done: '已完成',
    error: '失败',
    queued: '等待中',
    running: '生成中',
  };
  return labels[status] || '等待中';
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '未知大小';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(1).replace(/\.0$/, '.0');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
