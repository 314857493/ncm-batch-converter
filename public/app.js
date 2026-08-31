'use strict';

const elements = {
  dropZone: document.querySelector('#dropZone'),
  fileInput: document.querySelector('#fileInput'),
  pickButton: document.querySelector('#pickButton'),
  bitrate: document.querySelector('#bitrate'),
  folderButton: document.querySelector('#folderButton'),
  folderName: document.querySelector('#folderName'),
  folderHint: document.querySelector('#folderHint'),
  rightsCheck: document.querySelector('#rightsCheck'),
  queueCard: document.querySelector('#queueCard'),
  fileCount: document.querySelector('#fileCount'),
  clearButton: document.querySelector('#clearButton'),
  openFolderButton: document.querySelector('#openFolderButton'),
  startButton: document.querySelector('#startButton'),
  emptyState: document.querySelector('#emptyState'),
  jobList: document.querySelector('#jobList'),
  toast: document.querySelector('#toast'),
};

const state = {
  jobs: [],
  outputDirectory: '',
  running: false,
  toastTimer: null,
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const number = bytes / (1024 ** index);
  return `${number >= 10 || index === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[index]}`;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 2800);
}

function statusText(job) {
  const labels = {
    queued: '等待转换',
    uploading: `正在读取 ${Math.round(job.progress)}%`,
    converting: '正在解密 / 转码',
    saving: '正在保存',
    success: job.saved ? '已转换并保存' : '转换完成',
    error: job.error || '转换失败',
  };
  return labels[job.status] || job.status;
}

function render() {
  const pendingCount = state.jobs.filter((job) => ['queued', 'error'].includes(job.status)).length;
  elements.fileCount.textContent = `${state.jobs.length} 个文件`;
  elements.emptyState.hidden = state.jobs.length > 0;
  elements.jobList.classList.toggle('visible', state.jobs.length > 0);
  elements.startButton.disabled = state.running || !pendingCount || !elements.rightsCheck.checked || !state.outputDirectory;
  elements.startButton.textContent = state.running ? '转换进行中…' : '开始转换 →';
  elements.openFolderButton.disabled = !state.outputDirectory || state.running;
  elements.clearButton.disabled = state.running;

  elements.jobList.innerHTML = state.jobs.map((job) => {
    const progress = job.status === 'success' ? 100 : job.status === 'converting' || job.status === 'saving' ? 92 : job.progress;
    const action = job.status === 'success'
      ? `<a class="row-action" href="${job.url}" download="${escapeHtml(job.outputName)}" title="下载 ${escapeHtml(job.outputName)}">↓</a>`
      : `<button class="row-action remove-job" data-id="${job.id}" type="button" title="移除" ${state.running ? 'disabled' : ''}>×</button>`;
    return `
      <article class="job-row">
        <div class="file-glyph">NCM</div>
        <div class="file-info">
          <div class="file-name" title="${escapeHtml(job.file.name)}">${escapeHtml(job.outputName || job.file.name)}</div>
          <div class="file-meta">${escapeHtml(job.file.name)}${job.sourceFormat ? ` · ${job.sourceFormat.toUpperCase()} → MP3` : ''}</div>
        </div>
        <div class="file-size status ${job.status}">${escapeHtml(statusText(job))}<div class="progress-track"><div class="progress-bar" style="width:${Math.max(0, progress)}%"></div></div></div>
        <div class="file-size file-meta">${formatBytes(job.file.size)}</div>
        ${action}
      </article>`;
  }).join('');
}

function addFiles(fileList) {
  const files = [...fileList];
  const invalid = files.filter((file) => !file.name.toLowerCase().endsWith('.ncm'));
  const existing = new Set(state.jobs.map((job) => `${job.file.name}:${job.file.size}:${job.file.lastModified}`));
  let added = 0;

  for (const file of files) {
    if (!file.name.toLowerCase().endsWith('.ncm')) continue;
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (existing.has(key)) continue;
    existing.add(key);
    state.jobs.push({
      id: crypto.randomUUID(),
      file,
      status: 'queued',
      progress: 0,
      error: '',
      url: '',
      outputName: '',
      sourceFormat: '',
      saved: false,
    });
    added += 1;
  }

  if (invalid.length) showToast(`已忽略 ${invalid.length} 个非 NCM 文件`);
  else if (added) showToast(`已加入 ${added} 个文件`);
  render();
  if (added) elements.queueCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function convertRequest(job) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ filename: job.file.name, bitrate: elements.bitrate.value });
    const request = new XMLHttpRequest();
    request.open('POST', `/api/convert?${params}`);
    request.responseType = 'blob';
    request.setRequestHeader('Content-Type', 'application/octet-stream');

    request.upload.addEventListener('progress', (event) => {
      job.status = 'uploading';
      job.progress = event.lengthComputable ? Math.min(88, (event.loaded / event.total) * 88) : 25;
      render();
    });
    request.upload.addEventListener('load', () => {
      job.status = 'converting';
      job.progress = 90;
      render();
    });
    request.addEventListener('load', async () => {
      if (request.status === 200) {
        const encodedName = request.getResponseHeader('X-Output-Name') || 'converted.mp3';
        try { job.outputName = decodeURIComponent(encodedName); } catch { job.outputName = 'converted.mp3'; }
        const encodedSavedPath = request.getResponseHeader('X-Saved-Path') || '';
        try { job.savedPath = decodeURIComponent(encodedSavedPath); } catch { job.savedPath = ''; }
        job.sourceFormat = request.getResponseHeader('X-Source-Format') || '';
        resolve(request.response);
        return;
      }
      let message = `转换失败（HTTP ${request.status}）`;
      try {
        const payload = JSON.parse(await request.response.text());
        if (payload.error) message = payload.error;
      } catch {}
      reject(new Error(message));
    });
    request.addEventListener('error', () => reject(new Error('无法连接本地转换服务。')));
    request.addEventListener('abort', () => reject(new Error('转换已取消。')));
    request.send(job.file);
  });
}

async function processJob(job) {
  if (job.url) URL.revokeObjectURL(job.url);
  Object.assign(job, { status: 'uploading', progress: 1, error: '', url: '', saved: false });
  render();
  try {
    const blob = await convertRequest(job);
    job.status = 'saving';
    render();
    job.saved = Boolean(job.savedPath);
    job.url = URL.createObjectURL(blob);
    job.status = 'success';
    job.progress = 100;
  } catch (error) {
    job.status = 'error';
    job.progress = 0;
    job.error = error.message || '转换失败';
  }
  render();
}

async function startConversion() {
  if (state.running || !elements.rightsCheck.checked) return;
  const queue = state.jobs.filter((job) => ['queued', 'error'].includes(job.status));
  if (!queue.length) return;
  state.running = true;
  render();

  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const job = queue[cursor];
      cursor += 1;
      await processJob(job);
    }
  };
  await Promise.all([worker(), worker()]);

  state.running = false;
  render();
  const failed = queue.filter((job) => job.status === 'error').length;
  showToast(failed ? `转换结束，${failed} 个文件失败` : `全部 ${queue.length} 个文件转换完成`);
}

async function chooseOutputDirectory() {
  elements.folderButton.disabled = true;
  elements.folderName.textContent = '请选择文件夹…';
  try {
    const response = await fetch('/api/select-output-directory', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法更改输出目录');
    state.outputDirectory = payload.outputDirectory;
    updateOutputDirectoryLabel();
    if (!payload.cancelled) showToast(`输出目录已改为：${payload.outputDirectory}`);
  } catch (error) {
    showToast(error.message || '无法更改输出目录');
    updateOutputDirectoryLabel();
  } finally {
    elements.folderButton.disabled = false;
    render();
  }
}

function updateOutputDirectoryLabel() {
  if (!state.outputDirectory) {
    elements.folderName.textContent = '未设置输出目录';
    elements.folderHint.textContent = '点击选择保存位置';
    return;
  }
  elements.folderName.textContent = state.outputDirectory;
  elements.folderName.title = state.outputDirectory;
  elements.folderHint.textContent = '点击可更改；转换后自动保存';
}

async function loadSettings() {
  try {
    const response = await fetch('/api/settings');
    const payload = await response.json();
    state.outputDirectory = payload.outputDirectory || '';
  } catch {
    state.outputDirectory = '';
  }
  updateOutputDirectoryLabel();
  render();
}

async function openOutputDirectory() {
  try {
    const response = await fetch('/api/open-output-directory', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法打开输出目录');
    showToast(`已打开：${payload.outputDirectory}`);
  } catch (error) {
    showToast(error.message || '无法打开输出目录');
  }
}

elements.pickButton.addEventListener('click', (event) => { event.stopPropagation(); elements.fileInput.click(); });
elements.dropZone.addEventListener('click', () => elements.fileInput.click());
elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
});
elements.fileInput.addEventListener('change', () => { addFiles(elements.fileInput.files); elements.fileInput.value = ''; });
for (const eventName of ['dragenter', 'dragover']) {
  elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.add('dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.dropZone.addEventListener(eventName, (event) => { event.preventDefault(); elements.dropZone.classList.remove('dragging'); });
}
elements.dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
elements.folderButton.addEventListener('click', chooseOutputDirectory);
elements.startButton.addEventListener('click', startConversion);
elements.openFolderButton.addEventListener('click', openOutputDirectory);
elements.rightsCheck.addEventListener('change', render);
elements.clearButton.addEventListener('click', () => {
  if (state.running) return;
  state.jobs.forEach((job) => { if (job.url) URL.revokeObjectURL(job.url); });
  state.jobs = [];
  render();
});
elements.jobList.addEventListener('click', (event) => {
  const button = event.target.closest('.remove-job');
  if (!button || state.running) return;
  const index = state.jobs.findIndex((job) => job.id === button.dataset.id);
  if (index >= 0) state.jobs.splice(index, 1);
  render();
});

render();
loadSettings();
