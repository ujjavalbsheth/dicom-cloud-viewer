// ============================================================
// DICOM Cloud Viewer — Session 2b
// Loads studies as 3D volumes (backend change; UI stays the same as 2a)
// ============================================================

import * as viewer from './viewer.js';
import dicomParser from 'dicom-parser';

const PASSWORD_KEY = 'dicomViewerAuth';
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function authHeaders() {
  return { 'x-access-password': sessionStorage.getItem(PASSWORD_KEY) || '' };
}

// ============================================================
// Auth
// ============================================================

async function checkPassword() {
  const pwd = $('passwordInput').value;
  const errorEl = $('passwordError');
  errorEl.classList.add('hidden');
  if (!pwd) {
    errorEl.textContent = 'Enter a password';
    errorEl.classList.remove('hidden');
    return;
  }
  try {
    const res = await fetch('/api/verify', { headers: { 'x-access-password': pwd } });
    if (res.ok) {
      sessionStorage.setItem(PASSWORD_KEY, pwd);
      enterApp();
    } else {
      errorEl.textContent = 'Incorrect password';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Network error: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

function enterApp() {
  $('gate').classList.add('hidden');
  $('main').classList.remove('hidden');
  showStudies();
}

function logout() {
  sessionStorage.removeItem(PASSWORD_KEY);
  $('main').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('passwordInput').value = '';
}

// ============================================================
// View switching
// ============================================================

function showStudies() {
  viewer.cleanup();
  $('studiesView').classList.remove('hidden');
  $('uploadView').classList.add('hidden');
  $('viewerView').classList.add('hidden');
  loadStudies();
}

function showUpload() {
  viewer.cleanup();
  $('studiesView').classList.add('hidden');
  $('uploadView').classList.remove('hidden');
  $('viewerView').classList.add('hidden');
}

function showViewer() {
  $('studiesView').classList.add('hidden');
  $('uploadView').classList.add('hidden');
  $('viewerView').classList.remove('hidden');
}

// ============================================================
// Studies list
// ============================================================

async function loadStudies() {
  const listEl = $('studiesList');
  listEl.innerHTML = '<div class="muted">Loading...</div>';
  try {
    const res = await fetch('/api/list-studies', { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { studies } = await res.json();
    if (!studies || studies.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No studies uploaded yet.<br>
        <button class="link" id="uploadFirst">Upload your first study →</button></div>`;
      $('uploadFirst').addEventListener('click', showUpload);
      return;
    }
    listEl.innerHTML = studies.map((s) => `
      <div class="study-card" data-uid="${escapeAttr(s.studyUID)}">
        <div class="study-name">${escapeHtml(s.description || 'Untitled study')}</div>
        <div class="study-meta">${s.fileCount} files · ${escapeHtml(s.modality || 'Unknown modality')} · ${formatSize(s.totalSize)}</div>
        <div class="study-uid">${escapeHtml(s.studyUID)}</div>
      </div>`).join('');
    $$('.study-card').forEach((card) => {
      card.addEventListener('click', () => openStudy(card.dataset.uid));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// ============================================================
// Upload
// ============================================================

function toggleFolderMode() {
  const input = $('fileInput');
  if ($('folderMode').checked) {
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  } else {
    input.removeAttribute('webkitdirectory');
    input.removeAttribute('directory');
  }
}

async function startUpload() {
  const files = Array.from($('fileInput').files);
  if (files.length === 0) return alert('Pick a folder or files first.');
  const btn = $('uploadBtn');
  const status = $('uploadStatus');
  status.classList.remove('hidden');
  const logLines = [];
  const log = (msg) => {
    logLines.unshift(msg);
    status.textContent = logLines.slice(0, 200).join('\n');
  };
  log(`Starting upload of ${files.length} files...`);
  btn.disabled = true;
  let success = 0, failed = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const i = cursor++;
      const file = files[i];
      try {
        await uploadOne(file, i + 1, files.length, log);
        success++;
      } catch (err) {
        failed++;
        log(`[${i + 1}/${files.length}] ${file.name} — FAILED: ${err.message}`);
      }
    }
  }
  await Promise.all(Array(4).fill(0).map(worker));
  log('');
  log(`Done. ${success} succeeded, ${failed} failed.`);
  btn.disabled = false;
}

async function uploadOne(file, idx, total, log) {
  const arrayBuffer = await file.arrayBuffer();
  const byteArray = new Uint8Array(arrayBuffer);
  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (err) {
    throw new Error('Not a valid DICOM file');
  }
  const studyUID = dataSet.string('x0020000d');
  const seriesUID = dataSet.string('x0020000e');
  const instanceUID = dataSet.string('x00080018');
  if (!studyUID || !instanceUID) throw new Error('Missing required DICOM UIDs');
  const instanceNumber = parseInt(dataSet.string('x00200013') || '0', 10);
  const modality = dataSet.string('x00080060') || '';
  const studyDescription = dataSet.string('x00081030') || '';
  log(`[${idx}/${total}] ${file.name} — requesting URL...`);
  const urlRes = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ studyUID, seriesUID, instanceUID, instanceNumber, modality, studyDescription, size: file.size }),
  });
  if (!urlRes.ok) throw new Error('upload-url failed: ' + (await urlRes.text()).slice(0, 100));
  const { uploadUrl } = await urlRes.json();
  log(`[${idx}/${total}] ${file.name} — uploading ${formatSize(file.size)}...`);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/dicom' },
    body: arrayBuffer,
  });
  if (!putRes.ok) throw new Error('PUT failed: HTTP ' + putRes.status);
  log(`[${idx}/${total}] ${file.name} — done`);
}

// ============================================================
// Viewer
// ============================================================

let currentStudyTitle = '';

async function openStudy(studyUID) {
  showViewer();
  $('viewerTitle').textContent = 'Loading study...';
  $('viewerInfo').textContent = '';
  $('viewerProgress').textContent = '';

  try {
    $('viewerProgress').textContent = 'Initializing viewer...';
    await viewer.initViewer();

    $('viewerProgress').textContent = 'Fetching instance list...';
    const res = await fetch(`/api/list-instances?studyUID=${encodeURIComponent(studyUID)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { instances, description } = await res.json();

    if (!instances || instances.length === 0) {
      $('viewerTitle').textContent = 'No images found in this study';
      $('viewerProgress').textContent = '';
      return;
    }

    currentStudyTitle = description || studyUID;
    $('viewerTitle').textContent = currentStudyTitle;
    $('viewerInfo').textContent = `Loading volume...`;
    $('viewerProgress').textContent = 'Building 3D volume from slices...';

    const element = $('dicomViewport');
    const total = instances.length;

    await viewer.loadStudy(
      element,
      instances,
      // onVolumeProgress
      (loaded, tot) => {
        const pct = Math.round((loaded / tot) * 100);
        $('viewerProgress').textContent = `Loading volume: ${loaded} / ${tot} slices (${pct}%)`;
        if (loaded >= tot) {
          setTimeout(() => ($('viewerProgress').textContent = 'Volume ready'), 300);
          setTimeout(() => ($('viewerProgress').textContent = ''), 2500);
        }
      },
      // onSliceChange
      (idx) => {
        if (idx == null || idx < 0) return;
        $('viewerInfo').textContent = `Slice ${idx + 1} of ${total}`;
        $('sliceSlider').value = idx;
        $('sliceValue').textContent = `${idx + 1} / ${total}`;
      },
      // onRender
      () => {
        const wl = viewer.getWindowLevel();
        if (wl) $('overlayWL').textContent = `W: ${wl.windowWidth}  L: ${wl.windowCenter}`;
        const zoom = viewer.getZoom();
        if (zoom != null) $('overlayZoom').textContent = `Zoom: ${zoom}%`;
      }
    );

    // Set up slice slider
    const slider = $('sliceSlider');
    slider.max = total - 1;
    slider.value = 0;
    $('sliceValue').textContent = `1 / ${total}`;
    slider.addEventListener('input', () => {
      viewer.goToSlice(parseInt(slider.value, 10));
    });
  } catch (err) {
    $('viewerTitle').textContent = 'Failed to load: ' + err.message;
    $('viewerProgress').textContent = '';
    console.error('openStudy error:', err);
  }
}

// ============================================================
// Toolbar actions
// ============================================================

async function toggleFullscreen() {
  const container = $('viewportContainer');
  if (!container) return;
  const isRealFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  const isPseudoFullscreen = container.classList.contains('pseudo-fullscreen');

  if (isRealFullscreen || isPseudoFullscreen) {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    container.classList.remove('pseudo-fullscreen');
  } else {
    try {
      if (container.requestFullscreen) await container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
      else container.classList.add('pseudo-fullscreen');
    } catch (err) {
      container.classList.add('pseudo-fullscreen');
    }
  }
  setTimeout(() => viewer.resize(), 250);
}

async function takeScreenshot() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = currentStudyTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) || 'study';
    await viewer.screenshot(`${safeTitle}_${timestamp}.png`);
  } catch (err) {
    alert('Screenshot failed: ' + err.message);
  }
}

// ============================================================
// Wire up events
// ============================================================

$('loginBtn').addEventListener('click', checkPassword);
$('passwordInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') checkPassword();
});
$('logoutBtn').addEventListener('click', logout);
$('navStudies').addEventListener('click', showStudies);
$('navUpload').addEventListener('click', showUpload);
$('folderMode').addEventListener('change', toggleFolderMode);
$('uploadBtn').addEventListener('click', startUpload);

$$('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    viewer.setActiveTool(btn.dataset.tool);
    $$('.tool-btn[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

$$('.tool-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'rotate') viewer.rotateViewport();
    else if (action === 'flipH') viewer.flipH();
    else if (action === 'flipV') viewer.flipV();
    else if (action === 'invert') viewer.invert();
    else if (action === 'reset') viewer.reset();
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'screenshot') takeScreenshot();
  });
});

$$('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => viewer.applyPreset(btn.dataset.preset));
});

window.addEventListener('resize', () => viewer.resize());

if (sessionStorage.getItem(PASSWORD_KEY)) {
  fetch('/api/verify', { headers: authHeaders() }).then((r) => {
    if (r.ok) enterApp();
  });
}
