'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const ffmpegPath = require('ffmpeg-static');
const { convertNcmToMp3, NcmError } = require('./src/ncm');

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3210', 10);
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_DIR = path.join(__dirname, 'data');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');
const DEFAULT_OUTPUT_DIRECTORY = path.join(__dirname, 'output');

function loadOutputDirectory() {
  if (process.env.NCM_OUTPUT_DIRECTORY && path.isAbsolute(process.env.NCM_OUTPUT_DIRECTORY)) {
    return path.resolve(process.env.NCM_OUTPUT_DIRECTORY);
  }
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (typeof settings.outputDirectory === 'string' && path.isAbsolute(settings.outputDirectory)) {
      return path.resolve(settings.outputDirectory);
    }
  } catch {}
  return DEFAULT_OUTPUT_DIRECTORY;
}

let outputDirectory = loadOutputDirectory();
fs.mkdirSync(outputDirectory, { recursive: true });

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function safeOriginalName(value) {
  const decoded = String(value || 'music.ncm').slice(0, 500);
  return path.basename(decoded).replace(/[\u0000-\u001f]/g, '_');
}

function encodedHeader(value) {
  return encodeURIComponent(String(value || '')).slice(0, 3000);
}

async function persistOutputDirectory(directory) {
  await fsp.mkdir(SETTINGS_DIR, { recursive: true });
  const temporaryPath = `${SETTINGS_PATH}.tmp`;
  await fsp.writeFile(temporaryPath, JSON.stringify({ outputDirectory: directory }, null, 2), 'utf8');
  await fsp.rename(temporaryPath, SETTINGS_PATH);
}

async function saveConvertedFile(sourcePath, outputName) {
  await fsp.mkdir(outputDirectory, { recursive: true });
  const extension = path.extname(outputName) || '.mp3';
  const baseName = path.basename(outputName, extension);

  for (let suffix = 0; suffix < 10000; suffix += 1) {
    const candidateName = suffix ? `${baseName} (${suffix + 1})${extension}` : `${baseName}${extension}`;
    const candidatePath = path.join(outputDirectory, candidateName);
    try {
      await fsp.copyFile(sourcePath, candidatePath, fs.constants.COPYFILE_EXCL);
      return { path: candidatePath, name: candidateName };
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw new NcmError(`无法写入输出目录：${outputDirectory}`, 'OUTPUT_WRITE_FAILED');
    }
  }
  throw new NcmError('输出目录中存在过多重名文件。', 'OUTPUT_NAME_CONFLICT');
}

function selectNativeOutputDirectory() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择 MP3 输出目录'",
    '$dialog.ShowNewFolderButton = $true',
    '$dialog.SelectedPath = $env:NCM_INITIAL_OUTPUT',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '  [Console]::Write($dialog.SelectedPath)',
    '}',
  ].join('; ');

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      env: { ...process.env, NCM_INITIAL_OUTPUT: outputDirectory },
      windowsHide: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `Folder picker exited with ${code}`));
      else resolve(stdout.trim() || null);
    });
  });
}

async function handleSelectOutputDirectory(response) {
  try {
    const selected = await selectNativeOutputDirectory();
    if (!selected) return sendJson(response, 200, { cancelled: true, outputDirectory });
    if (!path.isAbsolute(selected)) return sendJson(response, 400, { error: '请选择有效的绝对路径。' });
    const resolved = path.resolve(selected);
    await fsp.mkdir(resolved, { recursive: true });
    await persistOutputDirectory(resolved);
    outputDirectory = resolved;
    return sendJson(response, 200, { cancelled: false, outputDirectory });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: '无法打开文件夹选择窗口。' });
  }
}

async function handleOpenOutputDirectory(response) {
  try {
    await fsp.mkdir(outputDirectory, { recursive: true });
    const child = spawn('explorer.exe', [outputDirectory], { detached: true, stdio: 'ignore' });
    child.unref();
    return sendJson(response, 200, { ok: true, outputDirectory });
  } catch (error) {
    return sendJson(response, 500, { error: '无法打开输出目录。' });
  }
}

async function receiveBody(request, targetPath) {
  const declaredSize = Number.parseInt(request.headers['content-length'] || '0', 10);
  if (declaredSize > MAX_FILE_SIZE) throw new NcmError('单个文件不能超过 4 GB。', 'FILE_TOO_LARGE');

  let received = 0;
  const limiter = new (require('node:stream').Transform)({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) callback(new NcmError('单个文件不能超过 4 GB。', 'FILE_TOO_LARGE'));
      else callback(null, chunk);
    },
  });
  await pipeline(request, limiter, fs.createWriteStream(targetPath, { flags: 'wx' }));
  if (!received) throw new NcmError('没有收到文件内容。', 'EMPTY_FILE');
}

async function handleConvert(request, response, url) {
  const originalName = safeOriginalName(url.searchParams.get('filename'));
  if (!originalName.toLowerCase().endsWith('.ncm')) {
    return sendJson(response, 400, { error: '只支持 .ncm 文件。', code: 'BAD_EXTENSION' });
  }

  const bitrate = url.searchParams.get('bitrate') || '320k';
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncm-converter-'));
  const inputPath = path.join(tempDirectory, 'upload.ncm');
  const outputPath = path.join(tempDirectory, 'converted.mp3');

  try {
    await receiveBody(request, inputPath);
    const result = await convertNcmToMp3(inputPath, outputPath, {
      ffmpegPath,
      bitrate,
      originalName,
    });
    const saved = await saveConvertedFile(outputPath, result.outputName);
    const stat = await fsp.stat(outputPath);
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="converted.mp3"; filename*=UTF-8''${encodeURIComponent(saved.name)}`,
      'X-Output-Name': encodedHeader(saved.name),
      'X-Saved-Path': encodedHeader(saved.path),
      'X-Source-Format': result.nativeFormat,
      'Cache-Control': 'no-store',
    });
    await pipeline(fs.createReadStream(outputPath), response);
  } catch (error) {
    if (!response.headersSent) {
      const known = error instanceof NcmError;
      sendJson(response, known ? 400 : 500, {
        error: known ? error.message : '转换过程中发生了意外错误。',
        code: known ? error.code : 'INTERNAL_ERROR',
      });
    } else if (!response.destroyed) {
      response.destroy(error);
    }
    if (!(error instanceof NcmError)) console.error(error);
  } finally {
    await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleStatic(response, pathname) {
  const item = staticFiles.get(pathname);
  if (!item) {
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      return response.end();
    }
    return sendJson(response, 404, { error: 'Not found' });
  }

  const [filename, contentType] = item;
  const filePath = path.join(PUBLIC_DIR, filename);
  const stat = await fsp.stat(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  await pipeline(fs.createReadStream(filePath), response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (request.method === 'POST' && url.pathname === '/api/convert') {
      return await handleConvert(request, response, url);
    }
    if (request.method === 'POST' && url.pathname === '/api/select-output-directory') {
      return await handleSelectOutputDirectory(response);
    }
    if (request.method === 'POST' && url.pathname === '/api/open-output-directory') {
      return await handleOpenOutputDirectory(response);
    }
    if (request.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(response, 200, { outputDirectory });
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { ok: true, ffmpeg: Boolean(ffmpegPath), outputDirectory });
    }
    if (request.method === 'GET') return await handleStatic(response, url.pathname);
    return sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: '服务器内部错误。' });
  }
});

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\nNCM Batch Converter is running: ${url}`);
  console.log('Press Ctrl+C to stop.\n');
  if (process.argv.includes('--open')) {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
});
