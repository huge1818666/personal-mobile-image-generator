import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT_DIR, '.cache', 'windows');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BUILD_DIR = path.join(DIST_DIR, 'windows-build');
const SERVER_FILE = path.join(ROOT_DIR, 'server.mjs');

const webVersion = await readWebVersion();
const packageName = `personal-mobile-image-generator-windows-${webVersion}`;
const packageDir = path.join(BUILD_DIR, packageName);
const zipPath = path.join(DIST_DIR, `${packageName}.zip`);

await rm(BUILD_DIR, { force: true, recursive: true });
await mkdir(packageDir, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });
await mkdir(DIST_DIR, { recursive: true });

const nodeInfo = await resolveNodeDownload();
const nodeZipPath = path.join(CACHE_DIR, nodeInfo.fileName);
await downloadIfNeeded(nodeInfo.url, nodeZipPath, nodeInfo.sha256);
const nodeExtractDir = path.join(CACHE_DIR, 'node-extract');
await rm(nodeExtractDir, { force: true, recursive: true });
await mkdir(nodeExtractDir, { recursive: true });
await execFileAsync('bsdtar', ['-xf', nodeZipPath, '-C', nodeExtractDir]);
const nodeSourceDir = path.join(nodeExtractDir, nodeInfo.fileName.replace(/\.zip$/i, ''));
await cp(nodeSourceDir, path.join(packageDir, 'node'), { recursive: true });

await mkdir(path.join(packageDir, 'app'), { recursive: true });
for (const fileName of ['server.mjs', 'image-api.mjs', 'package.json', 'package-lock.json']) {
  await cp(path.join(ROOT_DIR, fileName), path.join(packageDir, 'app', fileName));
}
await cp(path.join(ROOT_DIR, 'public'), path.join(packageDir, 'app', 'public'), { recursive: true });
await cp(path.join(ROOT_DIR, 'node_modules'), path.join(packageDir, 'app', 'node_modules'), { recursive: true });
await mkdir(path.join(packageDir, 'data'), { recursive: true });

await writeFile(path.join(packageDir, 'config.bat'), [
  '@echo off',
  'rem 管理员账号密码；需要改账号时编辑这里。',
  'set "APP_USERNAME=personal"',
  'set "APP_PASSWORD=personal123456"',
  'set "PORT=4273"',
  '',
].join('\r\n'), 'utf8');

await writeFile(path.join(packageDir, '启动.bat'), [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  'call "%~dp0config.bat"',
  'if "%APP_USERNAME%"=="" set "APP_USERNAME=personal"',
  'if "%APP_PASSWORD%"=="" set "APP_PASSWORD=personal123456"',
  'if "%PORT%"=="" set "PORT=4273"',
  'set "HOST=127.0.0.1"',
  'set "DATA_DIR=%~dp0data"',
  'set "HEIC_USE_JS_CONVERT=1"',
  'if not exist "%DATA_DIR%" mkdir "%DATA_DIR%"',
  'echo.',
  'echo 个人图片生成手机版正在启动...',
  'echo 地址：http://127.0.0.1:%PORT%/',
  'echo 管理员账号：%APP_USERNAME%',
  'echo 数据目录：%DATA_DIR%',
  'echo.',
  'start "" "http://127.0.0.1:%PORT%/"',
  '"%~dp0node\\node.exe" "%~dp0app\\server.mjs"',
  'echo.',
  'echo 服务已停止，按任意键关闭窗口。',
  'pause >nul',
  '',
].join('\r\n'), 'utf8');

await writeFile(path.join(packageDir, '打开网页.bat'), [
  '@echo off',
  'chcp 65001 >nul',
  'call "%~dp0config.bat"',
  'if "%PORT%"=="" set "PORT=4273"',
  'start "" "http://127.0.0.1:%PORT%/"',
  '',
].join('\r\n'), 'utf8');

await writeFile(path.join(packageDir, 'README-先看我.txt'), [
  '个人图片生成手机版 Windows 便携版',
  '',
  '使用方法：',
  '1. 解压整个文件夹。',
  '2. 双击“启动.bat”。',
  '3. 浏览器会自动打开 http://127.0.0.1:4273/',
  '4. 默认管理员账号：personal',
  '5. 默认管理员密码：personal123456',
  '',
  '第一次使用：',
  '登录后到页面下方“接口配置”里填写 API Key、接口地址、模型和默认比例，然后点保存。',
  'API Key 保存后不会回显，看到“留空保留当前 Key”就是已经保存。',
  '',
  '修改账号密码：',
  '右键编辑 config.bat，改 APP_USERNAME 和 APP_PASSWORD 后重新双击“启动.bat”。',
  '',
  '数据保存：',
  '所有用户、会话、接口配置、生成记录和图片都保存在 data 文件夹。',
  '要备份或迁移，复制整个文件夹即可。',
  '',
  '停止服务：',
  '关闭启动窗口即可。',
  '',
  '说明：',
  '本包已经内置 Windows Node 运行时和 HEIC/HEIF 转 JPG 依赖，不需要额外安装 Node、npm 或 Docker。',
  `版本：${webVersion}`,
  '',
].join('\r\n'), 'utf8');

await rm(zipPath, { force: true });
await execFileAsync('zip', ['-qry', zipPath, packageName], { cwd: BUILD_DIR, maxBuffer: 1024 * 1024 * 20 });

const zipStats = await stat(zipPath);
console.log(JSON.stringify({
  packageDir,
  sizeMb: Number((zipStats.size / 1024 / 1024).toFixed(2)),
  webVersion,
  zipPath,
}, null, 2));

async function readWebVersion() {
  const source = await readFile(SERVER_FILE, 'utf8');
  const match = source.match(/const WEB_VERSION = '([^']+)'/);
  if (!match) throw new Error('Cannot find WEB_VERSION in server.mjs');
  return match[1];
}

async function resolveNodeDownload() {
  const response = await fetch('https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt');
  if (!response.ok) throw new Error(`Failed to load Node checksum list: HTTP ${response.status}`);
  const text = await response.text();
  const line = text.split(/\r?\n/).find((item) => item.includes('win-x64.zip'));
  if (!line) throw new Error('Cannot find Windows x64 Node zip in checksum list');
  const [sha256, fileName] = line.trim().split(/\s+/);
  return {
    fileName,
    sha256,
    url: `https://nodejs.org/dist/latest-v22.x/${fileName}`,
  };
}

async function downloadIfNeeded(url, filePath, expectedSha256) {
  try {
    if (await sha256File(filePath) === expectedSha256) return;
  } catch {
    // Re-download below.
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${url} HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(filePath));
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${path.basename(filePath)}`);
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const buffer = await readFile(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}
