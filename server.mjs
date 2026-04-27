import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  editImage,
  generateImage,
  IMAGE_COST_CNY,
  IMAGE_SIZE_OPTIONS,
  isPlaceholderApiKey,
  PROJECT_DIR,
} from './image-api.mjs';

const PORT = Number(process.env.PORT || 4273);
const HOST = process.env.HOST || '0.0.0.0';
const APP_USERNAME = process.env.APP_USERNAME || 'personal';
const APP_PASSWORD = process.env.APP_PASSWORD || 'personal123456';
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_FILE = path.join(PROJECT_DIR, '.personal-data.json');
const SESSION_COOKIE = 'personal_image_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const ENV_ADMIN_ID = 'env-admin';
const MAX_JSON_BYTES = 70 * 1024 * 1024;
const MAX_BASE_IMAGES = 4;
const MAX_IMAGES = 30;
const MAX_JOBS = 30;
const MAX_CONCURRENT_JOBS = clampInteger(process.env.IMAGE_MAX_CONCURRENT_JOBS, 1, 1, 4);
const APP_VERSION = 'personal-v0.1.0';

const sessions = new Map();
const pendingJobOptions = new Map();
const runningJobs = new Set();
let dataMutationQueue = Promise.resolve();
let schedulingJobs = false;
let needsSchedule = false;
let heicConvertPromise = null;

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === 'GET' && requestUrl.pathname === '/api/session') {
      const session = getSession(request);
      return sendJson(response, 200, {
        authenticated: Boolean(session),
        role: session?.role || '',
        username: session?.username || '',
        version: APP_VERSION,
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/login') {
      const body = await readJson(request);
      const user = await authenticateUser(body.username, body.password);
      if (!user) {
        return sendJson(response, 401, { error: '账号或密码不正确。' });
      }

      const sessionId = randomBytes(32).toString('hex');
      await createSession(sessionId, user);
      return sendJson(response, 200, {
        authenticated: true,
        role: user.role,
        username: user.username,
        version: APP_VERSION,
      }, {
        'Set-Cookie': createSessionCookie(sessionId),
      });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/logout') {
      const sessionId = getCookie(request, SESSION_COOKIE);
      if (sessionId) await deleteSession(sessionId);
      return sendJson(response, 200, { authenticated: false }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      });
    }

    const session = getSession(request);
    if (isProtectedRequest(requestUrl) && !session) {
      return sendJson(response, 401, { error: '请先登录后再使用图片生成工具。' });
    }

    if (requestUrl.pathname.startsWith('/api/admin/')) {
      if (!isAdminSession(session)) {
        return sendJson(response, 403, { error: '只有管理员可以管理用户。' });
      }
      return handleAdminRequest(request, response, requestUrl);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/config') {
      const config = {
        appVersion: APP_VERSION,
        canCustomizeApi: isAdminSession(session),
        canManageUsers: isAdminSession(session),
        estimatedCostCny: IMAGE_COST_CNY,
        hasEnvApiKey: !isPlaceholderApiKey(DEFAULT_CONFIG.NEWAPI_API_KEY),
        maxBaseImages: MAX_BASE_IMAGES,
        maxImages: MAX_IMAGES,
        outputCompression: DEFAULT_CONFIG.IMAGE_OUTPUT_COMPRESSION,
        outputFormat: DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT,
        quality: DEFAULT_CONFIG.IMAGE_QUALITY || 'default',
        size: DEFAULT_CONFIG.IMAGE_SIZE,
        sizes: IMAGE_SIZE_OPTIONS,
      };
      if (isAdminSession(session)) {
        config.systemSettings = {
          baseUrl: DEFAULT_CONFIG.NEWAPI_BASE_URL,
          model: DEFAULT_CONFIG.IMAGE_MODEL,
        };
      }
      return sendJson(response, 200, config);
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/jobs') {
      const data = await readData();
      return sendJson(response, 200, {
        jobs: getVisibleJobs(data.jobs, session).map((job) => sanitizeJob(job, session)).slice(0, MAX_JOBS),
      });
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/api/jobs/')) {
      const jobId = decodeURIComponent(requestUrl.pathname.slice('/api/jobs/'.length));
      const data = await readData();
      const job = data.jobs.find((item) => item.id === jobId);
      if (!job || !canAccessOwnedItem(job, session)) return sendJson(response, 404, { error: '任务不存在或已清理。' });
      return sendJson(response, 200, { job: sanitizeJob(job, session) });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/images') {
      const data = await readData();
      return sendJson(response, 200, { images: getVisibleImages(data.images, session).slice(0, MAX_IMAGES) });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/generate') {
      const body = await readJson(request);
      assertImageSettingsAvailable(session, body);
      const job = await createImageJob({
        baseImages: [],
        mode: 'generate',
        options: getImageRequestOptions(body, session),
        outputCompression: body.outputCompression,
        outputFormat: body.outputFormat,
        prompt: body.prompt,
        quality: body.quality,
        size: body.size,
        owner: session,
      });
      enqueueJob(job.id, {
        baseImages: [],
        mode: 'generate',
        options: getImageRequestOptions(body, session),
        outputCompression: body.outputCompression,
        outputFormat: body.outputFormat,
        owner: getJobOwner(session),
        prompt: body.prompt,
        quality: body.quality,
        size: body.size,
      });
      return sendJson(response, 202, { job: sanitizeJob(job, session), jobId: job.id });
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/edit') {
      const body = await readJson(request);
      assertImageSettingsAvailable(session, body);
      const baseImages = await readBaseImagesFromRequest(body);
      const job = await createImageJob({
        baseImages,
        mode: 'edit',
        options: getImageRequestOptions(body, session),
        outputCompression: body.outputCompression,
        outputFormat: body.outputFormat,
        prompt: body.prompt,
        quality: body.quality,
        size: body.size,
        owner: session,
      });
      enqueueJob(job.id, {
        baseImages,
        mode: 'edit',
        options: getImageRequestOptions(body, session),
        outputCompression: body.outputCompression,
        outputFormat: body.outputFormat,
        owner: getJobOwner(session),
        prompt: body.prompt,
        quality: body.quality,
        size: body.size,
      });
      return sendJson(response, 202, { job: sanitizeJob(job, session), jobId: job.id });
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/generated/')) {
      const fileName = path.basename(decodeURIComponent(requestUrl.pathname.slice('/generated/'.length)));
      if (!/^image-.*\.(png|jpg|jpeg|webp)$/i.test(fileName)) {
        return sendJson(response, 404, { error: 'Not found' });
      }
      return sendFile(response, path.join(PROJECT_DIR, fileName));
    }

    if (request.method === 'GET') {
      const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
      const fileName = path.basename(decodeURIComponent(pathname));
      return sendFile(response, path.join(PUBLIC_DIR, fileName));
    }

    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    sendJson(response, statusCode, {
      error: error.message || 'Server error',
      diagnosis: error.diagnosis || '',
      responseText: error.responseText || '',
    });
  }
});

server.listen(PORT, HOST, async () => {
  await loadSessions();
  await markInterruptedJobs();
  console.log(`Personal image generator running at http://${HOST}:${PORT}`);
  console.log(`Username: ${APP_USERNAME}`);
  console.log(`Images will be saved in ${PROJECT_DIR}.`);
});

function isProtectedRequest(requestUrl) {
  return requestUrl.pathname.startsWith('/api/')
    || requestUrl.pathname.startsWith('/generated/');
}

async function loadSessions() {
  const data = await readData();
  hydrateSessions(data.sessions);
  const activeSessions = getPersistentSessions();
  if (activeSessions.length !== data.sessions.length) {
    data.sessions = activeSessions;
    await writeData(data);
  }
}

async function createSession(sessionId, user) {
  const now = Date.now();
  sessions.set(sessionId, {
    createdAt: now,
    expiresAt: now + SESSION_MAX_AGE_MS,
    role: user.role,
    userId: user.id,
    username: user.username,
  });
  await persistSessions();
}

async function deleteSession(sessionId) {
  sessions.delete(sessionId);
  await persistSessions();
}

async function persistSessions() {
  await mutateData(async (data) => {
    data.sessions = getPersistentSessions();
  });
}

function hydrateSessions(sessionRecords = []) {
  sessions.clear();
  const now = Date.now();
  for (const record of sessionRecords) {
    const sessionId = String(record?.id || '');
    const expiresAt = Number(record?.expiresAt || 0);
    if (!sessionId || !record?.username || expiresAt <= now) continue;
    sessions.set(sessionId, {
      createdAt: Number(record.createdAt || now),
      expiresAt,
      role: normalizeUserRole(record.role),
      userId: String(record.userId || ''),
      username: String(record.username || ''),
    });
  }
}

function getPersistentSessions() {
  const now = Date.now();
  return [...sessions.entries()]
    .filter(([, session]) => Number(session.expiresAt || 0) > now)
    .map(([id, session]) => ({
      createdAt: Number(session.createdAt || now),
      expiresAt: Number(session.expiresAt || now + SESSION_MAX_AGE_MS),
      id,
      role: normalizeUserRole(session.role),
      userId: String(session.userId || ''),
      username: String(session.username || ''),
    }));
}

function createSessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

async function handleAdminRequest(request, response, requestUrl) {
  if (request.method === 'GET' && requestUrl.pathname === '/api/admin/users') {
    const data = await readData();
    return sendJson(response, 200, { users: getAdminUserList(data.users) });
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/admin/users') {
    const body = await readJson(request);
    const user = await createManagedUser(body);
    return sendJson(response, 201, { user });
  }

  if (request.method === 'PUT' && requestUrl.pathname.startsWith('/api/admin/users/')) {
    const userId = decodeURIComponent(requestUrl.pathname.slice('/api/admin/users/'.length));
    const body = await readJson(request);
    const user = await updateManagedUser(userId, body);
    return sendJson(response, 200, { user });
  }

  return sendJson(response, 404, { error: 'Not found' });
}

async function authenticateUser(username, password) {
  const normalizedUsername = String(username || '').trim();
  const inputPassword = String(password || '');
  if (
    timingSafeStringEqual(normalizedUsername, APP_USERNAME)
    && timingSafeStringEqual(inputPassword, APP_PASSWORD)
  ) {
    return {
      active: true,
      id: ENV_ADMIN_ID,
      role: 'admin',
      username: APP_USERNAME,
    };
  }

  const data = await readData();
  const user = data.users.find((item) => item.active !== false && item.username === normalizedUsername);
  if (!user || !verifyPassword(inputPassword, user.passwordHash)) return null;
  return {
    active: true,
    id: user.id,
    role: normalizeUserRole(user.role),
    username: user.username,
  };
}

function getImageRequestOptions(body, session) {
  if (!isAdminSession(session)) return {};
  return {
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
    model: body.model,
  };
}

function assertImageSettingsAvailable(session, body) {
  if (isAdminSession(session)) return;
  if (body.apiKey || body.baseUrl || body.model) {
    throw Object.assign(new Error('普通用户不能自定义图片接口参数，请联系管理员配置后再使用。'), { statusCode: 403 });
  }
  if (!isPlaceholderApiKey(DEFAULT_CONFIG.NEWAPI_API_KEY)) return;
  throw Object.assign(new Error('当前未配置图片 API Key，请联系管理员设置环境变量后再使用。'), { statusCode: 400 });
}

async function createManagedUser(body) {
  return mutateData(async (data) => {
    const username = normalizeManagedUsername(body.username);
    assertUsernameAvailable(data.users, username);
    const password = normalizeManagedPassword(body.password, true);
    const now = new Date().toISOString();
    const user = {
      active: body.active !== false,
      createdAt: now,
      id: randomBytes(10).toString('hex'),
      passwordHash: createPasswordHash(password),
      role: normalizeUserRole(body.role),
      updatedAt: now,
      username,
    };
    data.users.unshift(user);
    return sanitizeUser(user);
  });
}

async function updateManagedUser(userId, body) {
  if (userId === ENV_ADMIN_ID) {
    throw Object.assign(new Error('环境变量管理员请通过 APP_USERNAME 和 APP_PASSWORD 修改。'), { statusCode: 400 });
  }

  return mutateData(async (data) => {
    const user = data.users.find((item) => item.id === userId);
    if (!user) throw Object.assign(new Error('用户不存在。'), { statusCode: 404 });

    const username = normalizeManagedUsername(body.username);
    assertUsernameAvailable(data.users, username, user.id);
    user.username = username;
    user.role = normalizeUserRole(body.role);
    user.active = body.active !== false;

    const password = normalizeManagedPassword(body.password, false);
    if (password) user.passwordHash = createPasswordHash(password);

    user.updatedAt = new Date().toISOString();
    return sanitizeUser(user);
  });
}

function getAdminUserList(users) {
  return [
    {
      active: true,
      canEdit: false,
      createdAt: '',
      id: ENV_ADMIN_ID,
      role: 'admin',
      source: 'env',
      updatedAt: '',
      username: APP_USERNAME,
    },
    ...users.map(sanitizeUser),
  ];
}

function sanitizeUser(user) {
  return {
    active: user.active !== false,
    canEdit: true,
    createdAt: user.createdAt || '',
    id: user.id,
    role: normalizeUserRole(user.role),
    source: 'managed',
    updatedAt: user.updatedAt || user.createdAt || '',
    username: user.username || '',
  };
}

function normalizeManagedUsername(username) {
  const normalized = String(username || '').trim();
  if (normalized.length < 2 || normalized.length > 40) {
    throw Object.assign(new Error('账号长度需要在 2-40 个字符之间。'), { statusCode: 400 });
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw Object.assign(new Error('账号不能包含控制字符。'), { statusCode: 400 });
  }
  return normalized;
}

function normalizeManagedPassword(password, required) {
  const normalized = String(password || '');
  if (!normalized && !required) return '';
  if (normalized.length < 6 || normalized.length > 80) {
    throw Object.assign(new Error('密码长度需要在 6-80 个字符之间。'), { statusCode: 400 });
  }
  return normalized;
}

function normalizeUserRole(role) {
  return String(role || 'user').trim() === 'admin' ? 'admin' : 'user';
}

function assertUsernameAvailable(users, username, currentUserId = '') {
  if (username === APP_USERNAME && currentUserId !== ENV_ADMIN_ID) {
    throw Object.assign(new Error('这个账号已被环境变量管理员使用。'), { statusCode: 409 });
  }
  const exists = users.some((user) => user.id !== currentUserId && user.username === username);
  if (exists) throw Object.assign(new Error('这个账号已经存在。'), { statusCode: 409 });
}

function createPasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [scheme, salt, hash] = String(passwordHash || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hash) {
    return timingSafeStringEqual(String(password || ''), String(passwordHash || ''));
  }
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(password || ''), salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function createImageJob({ baseImages, mode, options, outputCompression, outputFormat, owner, prompt, quality, size }) {
  return mutateData(async (data) => {
    const now = new Date().toISOString();
    const jobOwner = getJobOwner(owner);
    const job = {
      id: randomBytes(10).toString('hex'),
      baseImages: sanitizeJobBaseImages(baseImages),
      createdAt: now,
      diagnosis: '',
      elapsedMs: null,
      error: '',
      estimatedCostCny: IMAGE_COST_CNY,
      failedAt: '',
      finishedAt: '',
      mode,
      model: String(options.model || DEFAULT_CONFIG.IMAGE_MODEL || 'gpt-image-2').trim(),
      outputCompression: outputCompression ?? DEFAULT_CONFIG.IMAGE_OUTPUT_COMPRESSION,
      outputFormat: outputFormat || DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT,
      ownerUserId: jobOwner.ownerUserId,
      ownerUsername: jobOwner.ownerUsername,
      prompt: String(prompt || '').trim(),
      quality: String(quality || DEFAULT_CONFIG.IMAGE_QUALITY || 'default').trim() || 'default',
      responseText: '',
      result: null,
      size: String(size || DEFAULT_CONFIG.IMAGE_SIZE || 'auto').trim(),
      startedAt: '',
      status: 'queued',
      updatedAt: now,
    };
    data.jobs.unshift(job);
    data.jobs = data.jobs.slice(0, MAX_JOBS);
    return job;
  });
}

function enqueueJob(jobId, options) {
  pendingJobOptions.set(jobId, options);
  scheduleJobs().catch((error) => console.error('Failed to schedule image jobs:', error));
}

async function scheduleJobs() {
  if (schedulingJobs) {
    needsSchedule = true;
    return;
  }
  schedulingJobs = true;

  try {
    needsSchedule = false;
    const data = await readData();
    const queuedJobIds = new Set(data.jobs.filter((job) => job.status === 'queued').map((job) => job.id));
    for (const jobId of pendingJobOptions.keys()) {
      if (!queuedJobIds.has(jobId)) pendingJobOptions.delete(jobId);
    }

    for (const job of data.jobs) {
      if (runningJobs.size >= MAX_CONCURRENT_JOBS) break;
      if (job.status !== 'queued' || !pendingJobOptions.has(job.id)) continue;

      const options = pendingJobOptions.get(job.id);
      pendingJobOptions.delete(job.id);
      runningJobs.add(job.id);
      runImageJob(job.id, options)
        .catch((error) => console.error(`Image job ${job.id} failed unexpectedly:`, error))
        .finally(() => {
          runningJobs.delete(job.id);
          scheduleJobs().catch((error) => console.error('Failed to schedule next job:', error));
        });
    }
  } finally {
    schedulingJobs = false;
    if (needsSchedule) scheduleJobs().catch((error) => console.error('Failed to reschedule jobs:', error));
  }
}

async function runImageJob(jobId, jobOptions) {
  const startedAt = Date.now();
  try {
    await updateJob(jobId, {
      diagnosis: '',
      error: '',
      responseText: '',
      startedAt: new Date(startedAt).toISOString(),
      status: 'running',
    });

    const result = jobOptions.mode === 'edit'
      ? await editImage({
        apiKey: jobOptions.options.apiKey,
        baseImages: jobOptions.baseImages.map((image) => ({
          buffer: image.buffer,
          fileName: image.fileName,
          label: image.label,
          mimeType: image.mimeType,
          role: image.role,
        })),
        baseUrl: jobOptions.options.baseUrl,
        model: jobOptions.options.model,
        outputCompression: jobOptions.outputCompression,
        outputFormat: jobOptions.outputFormat,
        prompt: jobOptions.prompt,
        quality: jobOptions.quality,
        size: jobOptions.size,
      })
      : await generateImage({
        apiKey: jobOptions.options.apiKey,
        baseUrl: jobOptions.options.baseUrl,
        model: jobOptions.options.model,
        outputCompression: jobOptions.outputCompression,
        outputFormat: jobOptions.outputFormat,
        prompt: jobOptions.prompt,
        quality: jobOptions.quality,
        size: jobOptions.size,
      });

    const publicResult = {
      ...result,
      imageUrl: `/generated/${encodeURIComponent(result.fileName)}`,
    };

    await rememberImage(publicResult, jobOptions.owner);
    await updateJob(jobId, {
      elapsedMs: Date.now() - startedAt,
      error: '',
      finishedAt: new Date().toISOString(),
      result: publicResult,
      status: 'done',
    });
  } catch (error) {
    await safeUpdateJob(jobId, {
      diagnosis: error.diagnosis || '',
      elapsedMs: Date.now() - startedAt,
      error: error.message || '图片任务失败。',
      failedAt: new Date().toISOString(),
      responseText: error.responseText || '',
      status: 'error',
    });
  }
}

async function updateJob(jobId, patch) {
  return mutateData(async (data) => {
    const job = data.jobs.find((item) => item.id === jobId);
    if (!job) throw Object.assign(new Error('任务不存在或已清理。'), { statusCode: 404 });
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  });
}

async function safeUpdateJob(jobId, patch) {
  try {
    return await updateJob(jobId, patch);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

async function rememberImage(result, owner = {}) {
  await mutateData(async (data) => {
    data.images.unshift({
      fileName: result.fileName,
      imageUrl: result.imageUrl,
      modifiedAt: new Date().toISOString(),
      outputFormat: result.outputFormat,
      ownerUserId: owner.ownerUserId || '',
      ownerUsername: owner.ownerUsername || '',
      size: result.bytes || result.size || 0,
    });
    const removed = data.images.slice(MAX_IMAGES);
    data.images = data.images.slice(0, MAX_IMAGES);
    await removeImages(removed);
  });
}

async function markInterruptedJobs() {
  await mutateData(async (data) => {
    const now = new Date().toISOString();
    for (const job of data.jobs) {
      if (!['queued', 'running'].includes(job.status)) continue;
      job.status = 'error';
      job.error = '服务曾经重启，未完成的后台任务已中断，请重新提交。';
      job.failedAt = now;
      job.updatedAt = now;
    }
  });
}

function sanitizeJob(job, session) {
  const admin = isAdminSession(session);
  const sanitized = {
    id: job.id,
    baseImages: job.baseImages || [],
    createdAt: job.createdAt,
    diagnosis: job.diagnosis || '',
    elapsedMs: job.elapsedMs || null,
    error: job.error || '',
    estimatedCostCny: job.estimatedCostCny || IMAGE_COST_CNY,
    failedAt: job.failedAt || '',
    finishedAt: job.finishedAt || '',
    mode: job.mode,
    outputCompression: job.outputCompression ?? DEFAULT_CONFIG.IMAGE_OUTPUT_COMPRESSION,
    outputFormat: job.outputFormat || DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT,
    ownerUsername: admin ? (job.ownerUsername || '') : undefined,
    prompt: job.prompt,
    quality: job.quality || 'default',
    responseText: admin ? (job.responseText || '') : '',
    result: sanitizeJobResult(job.result, admin),
    size: job.size || 'auto',
    startedAt: job.startedAt || '',
    status: job.status || 'queued',
    updatedAt: job.updatedAt || job.createdAt,
  };
  if (admin) sanitized.model = job.model;
  return sanitized;
}

function sanitizeJobResult(result, admin) {
  if (!result) return null;
  const sanitized = {
    bytes: result.bytes || 0,
    estimatedCostCny: result.estimatedCostCny || IMAGE_COST_CNY,
    fileName: result.fileName || '',
    imageUrl: result.imageUrl || '',
    outputCompression: result.outputCompression ?? DEFAULT_CONFIG.IMAGE_OUTPUT_COMPRESSION,
    outputFormat: result.outputFormat || DEFAULT_CONFIG.IMAGE_OUTPUT_FORMAT,
    quality: result.quality || 'default',
    size: result.size || 'auto',
    timings: result.timings || null,
    usage: result.usage || null,
  };
  if (admin) {
    sanitized.endpoint = result.endpoint || '';
    sanitized.model = result.model || '';
    sanitized.outputPath = result.outputPath || '';
  }
  return sanitized;
}

function getVisibleJobs(jobs, session) {
  if (isAdminSession(session)) return jobs;
  return jobs.filter((job) => canAccessOwnedItem(job, session));
}

function getVisibleImages(images, session) {
  if (isAdminSession(session)) return images;
  return images.filter((image) => canAccessOwnedItem(image, session));
}

function canAccessOwnedItem(item, session) {
  if (isAdminSession(session)) return true;
  return Boolean(session?.userId && item?.ownerUserId && item.ownerUserId === session.userId);
}

function getJobOwner(session) {
  return {
    ownerUserId: session?.userId || '',
    ownerUsername: session?.username || '',
  };
}

function isAdminSession(session) {
  return session?.role === 'admin';
}

function sanitizeJobBaseImages(baseImages = []) {
  return baseImages.map((image, index) => ({
    fileName: image.fileName || '',
    kind: image.kind || 'upload',
    label: image.label || `图片${index + 1}`,
    role: image.role || 'input',
    size: image.size || image.buffer?.length || 0,
  }));
}

async function readBaseImagesFromRequest(body) {
  const inputs = Array.isArray(body.baseImages) ? body.baseImages : [];
  if (!inputs.length) {
    throw Object.assign(new Error('请先上传底图。'), { statusCode: 400 });
  }
  if (inputs.length > MAX_BASE_IMAGES) {
    throw Object.assign(new Error(`最多只能使用 ${MAX_BASE_IMAGES} 张底图。`), { statusCode: 400 });
  }

  const baseImages = [];
  for (const input of inputs) {
    if (input.baseFileName) {
      const filePath = await resolveGeneratedImagePath(input.baseFileName);
      const fileStats = await stat(filePath);
      baseImages.push({
        buffer: await readFile(filePath),
        fileName: path.basename(filePath),
        kind: 'generated',
        label: normalizeBaseImageLabel(input.baseImageLabel, baseImages.length),
        mimeType: contentTypeFor(filePath).split(';')[0],
        role: normalizeBaseImageRole(input.baseImageRole, 'target'),
        size: fileStats.size,
      });
      continue;
    }
    if (input.baseImageData) {
      baseImages.push(await parseUploadedImageData(input.baseImageData, input.baseImageName, input, baseImages.length));
    }
  }

  if (!baseImages.length) {
    throw Object.assign(new Error('请先选择至少一张底图。'), { statusCode: 400 });
  }
  return baseImages;
}

async function parseUploadedImageData(baseImageData, baseImageName, input = {}, index = 0) {
  const match = String(baseImageData).match(/^data:(image\/(?:png|jpe?g|webp|hei[cf]));base64,([\s\S]+)$/i);
  if (!match) {
    throw Object.assign(new Error('上传底图只支持 PNG、JPG/JPEG、WEBP、HEIC/HEIF 格式。'), { statusCode: 400 });
  }

  let mimeType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  let buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    throw Object.assign(new Error('上传底图内容为空。'), { statusCode: 400 });
  }
  let fileName = path.basename(String(baseImageName || `uploaded-${Date.now()}${extensionForImageMimeType(mimeType)}`));

  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    const converted = await convertHeicToJpeg(buffer, fileName);
    buffer = converted.buffer;
    fileName = converted.fileName;
    mimeType = converted.mimeType;
  }

  return {
    buffer,
    fileName,
    kind: 'upload',
    label: normalizeBaseImageLabel(input.baseImageLabel, index),
    mimeType,
    role: normalizeBaseImageRole(input.baseImageRole, index === 0 ? 'target' : 'reference'),
    size: buffer.length,
  };
}

async function convertHeicToJpeg(buffer, fileName) {
  try {
    const convert = await getHeicConvert();
    const jpegBuffer = Buffer.from(await convert({
      buffer,
      format: 'JPEG',
      quality: 0.88,
    }));
    return {
      buffer: jpegBuffer,
      fileName: replaceImageExtension(fileName, '.jpg'),
      mimeType: 'image/jpeg',
    };
  } catch (error) {
    throw Object.assign(new Error(`HEIC/HEIF 底图转换失败：${error.message || '请先转成 JPG 后再上传。'}`), {
      statusCode: 400,
    });
  }
}

async function getHeicConvert() {
  heicConvertPromise ||= import('heic-convert').then((module) => module.default || module);
  return heicConvertPromise;
}

function replaceImageExtension(fileName, extension) {
  const safeName = path.basename(String(fileName || `uploaded-${Date.now()}${extension}`));
  return /\.[^.]+$/.test(safeName) ? safeName.replace(/\.[^.]+$/, extension) : `${safeName}${extension}`;
}

function extensionForImageMimeType(mimeType) {
  return {
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  }[mimeType] || '.png';
}

function normalizeBaseImageLabel(label, index) {
  const normalized = String(label || '').trim();
  if (/^图片[1-4]$/.test(normalized)) return normalized;
  return `图片${index + 1}`;
}

function normalizeBaseImageRole(role, fallback = 'input') {
  const normalized = String(role || '').trim();
  return ['target', 'reference', 'input'].includes(normalized) ? normalized : fallback;
}

async function resolveGeneratedImagePath(fileName) {
  const safeName = path.basename(String(fileName || ''));
  if (!/^image-.*\.(png|jpg|jpeg|webp)$/i.test(safeName)) {
    throw Object.assign(new Error('底图文件格式不支持。'), { statusCode: 400 });
  }
  const filePath = path.resolve(PROJECT_DIR, safeName);
  const projectDir = path.resolve(PROJECT_DIR);
  if (filePath !== projectDir && !filePath.startsWith(`${projectDir}${path.sep}`)) {
    throw Object.assign(new Error('底图路径不合法。'), { statusCode: 400 });
  }
  try {
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error('not a file');
  } catch {
    throw Object.assign(new Error('找不到这张底图，请重新选择。'), { statusCode: 404 });
  }
  return filePath;
}

async function readData() {
  let data;
  try {
    data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    data = { images: [], jobs: [], sessions: [], users: [] };
  }
  if (!Array.isArray(data.images)) data.images = [];
  if (!Array.isArray(data.jobs)) data.jobs = [];
  if (!Array.isArray(data.sessions)) data.sessions = [];
  if (!Array.isArray(data.users)) data.users = [];
  data.sessions = data.sessions
    .filter((session) => session && session.id && session.username)
    .map((session) => ({
      createdAt: Number(session.createdAt || 0),
      expiresAt: Number(session.expiresAt || 0),
      id: String(session.id || ''),
      role: normalizeUserRole(session.role),
      userId: String(session.userId || ''),
      username: String(session.username || ''),
    }));
  data.users = data.users
    .filter((user) => user && user.id && user.username && user.passwordHash)
    .map((user) => ({
      active: user.active !== false,
      createdAt: user.createdAt || '',
      id: String(user.id),
      passwordHash: String(user.passwordHash),
      role: normalizeUserRole(user.role),
      updatedAt: user.updatedAt || user.createdAt || '',
      username: String(user.username || '').trim(),
    }));
  return data;
}

async function writeData(data) {
  await mkdir(PROJECT_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify({
    images: data.images.slice(0, MAX_IMAGES),
    jobs: data.jobs.slice(0, MAX_JOBS),
    sessions: data.sessions || [],
    users: data.users,
  }, null, 2));
}

async function mutateData(mutator) {
  const mutation = dataMutationQueue.then(async () => {
    const data = await readData();
    const result = await mutator(data);
    await writeData(data);
    return result;
  });
  dataMutationQueue = mutation.catch(() => {});
  return mutation;
}

async function removeImages(images) {
  for (const image of images) {
    if (!image.fileName || !/^image-/.test(image.fileName)) continue;
    try {
      await unlink(path.join(PROJECT_DIR, path.basename(image.fileName)));
    } catch {
      // Best-effort cleanup.
    }
  }
}

function getSession(request) {
  const sessionId = getCookie(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Number(session.expiresAt || 0) <= Date.now()) {
    sessions.delete(sessionId);
    persistSessions().catch((error) => console.error('Failed to persist expired session cleanup:', error));
    return null;
  }
  return session;
}

function getCookie(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split('=');
    if (key === name) return valueParts.join('=');
  }
  return '';
}

async function readJson(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_JSON_BYTES) {
      throw Object.assign(new Error('上传内容太大，请使用总计 60MB 以内的图片。'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求 JSON 格式不正确。'), { statusCode: 400 });
  }
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function sendFile(response, filePath) {
  const resolvedPath = path.resolve(filePath);
  const allowedRoots = [path.resolve(PUBLIC_DIR), path.resolve(PROJECT_DIR)];
  if (!allowedRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`))) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  try {
    const fileStats = await stat(resolvedPath);
    if (!fileStats.isFile()) return sendJson(response, 404, { error: 'Not found' });
  } catch {
    return sendJson(response, 404, { error: 'Not found' });
  }
  response.writeHead(200, {
    'Cache-Control': resolvedPath.startsWith(PUBLIC_DIR) ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Type': contentTypeFor(resolvedPath),
  });
  createReadStream(resolvedPath).pipe(response);
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }[extension] || 'application/octet-stream';
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(min, Math.min(max, Number(fallback) || min));
  return Math.max(min, Math.min(max, Math.round(number)));
}
