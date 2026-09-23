// ============================================================
// DICOM Cloud Viewer — Session 3a (Curved MPR + Panorama)
// ============================================================

import * as viewer from './viewer.js';
import * as curvedMPR from './curvedMPR.js';
import dicomParser from 'dicom-parser';

const PASSWORD_KEY = 'dicomViewerAuth';
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

function authHeaders() {
  return { 'x-access-password': sessionStorage.getItem(PASSWORD_KEY) || '' };
}

// ============================================================
// Auth (unchanged)
// ============================================================

async function checkPassword() {
  const pwd = $('passwordInput').value;
  const errorEl = $('passwordError');
  errorEl.classList.add('hidden');
  if (!pwd) { errorEl.textContent = 'Enter a password'; errorEl.classList.remove('hidden'); return; }
  try {
    const res = await fetch('/api/verify', { headers: { 'x-access-password': pwd } });
    if (res.ok) { sessionStorage.setItem(PASSWORD_KEY, pwd); enterApp(); }
    else { errorEl.textContent = 'Incorrect password'; errorEl.classList.remove('hidden'); }
  } catch (err) { errorEl.textContent = 'Network error: ' + err.message; errorEl.classList.remove('hidden'); }
}

function enterApp() {
  $('gate').classList.add('hidden');
  $('main').classList.remove('hidden');
  applyModeUI();
  showStudies();
}

function logout() {
  sessionStorage.removeItem(PASSWORD_KEY);
  $('main').classList.add('hidden');
  $('gate').classList.remove('hidden');
  $('passwordInput').value = '';
}

// ============================================================
// UI mode toggle
// ============================================================

function applyModeUI() {
  const isMobile = viewer.isMobileDevice();
  if (isMobile) {
    $('mprGrid').classList.add('hidden');
    $('stackContainer').classList.remove('hidden');
    $('mobileHint').classList.remove('hidden');
    $('curvedMPRPanel').classList.add('hidden');
    document.querySelectorAll('.desktop-only').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.mobile-only').forEach((el) => el.classList.remove('hidden'));
  } else {
    $('mprGrid').classList.remove('hidden');
    $('stackContainer').classList.add('hidden');
    $('mobileHint').classList.add('hidden');
    document.querySelectorAll('.desktop-only').forEach((el) => el.classList.remove('hidden'));
    document.querySelectorAll('.mobile-only').forEach((el) => el.classList.add('hidden'));
  }
}

function showStudies() {
  viewer.cleanup();
  curvedMPR.clearCurve();
  $('studiesView').classList.remove('hidden');
  $('uploadView').classList.add('hidden');
  $('viewerView').classList.add('hidden');
  loadStudies();
}

function showUpload() {
  viewer.cleanup();
  curvedMPR.clearCurve();
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

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  if (bytes < 1024*1024*1024) return (bytes/1024/1024).toFixed(1) + ' MB';
  return (bytes/1024/1024/1024).toFixed(2) + ' GB';
}

// ============================================================
// Upload (unchanged)
// ============================================================

function toggleFolderMode() {
  const input = $('fileInput');
  if ($('folderMode').checked) {
    input.setAttribute('webkitdirectory', ''); input.setAttribute('directory', '');
  } else {
    input.removeAttribute('webkitdirectory'); input.removeAttribute('directory');
  }
}

async function startUpload() {
  const files = Array.from($('fileInput').files);
  if (files.length === 0) return alert('Pick a folder or files first.');
  const btn = $('uploadBtn'); const status = $('uploadStatus');
  status.classList.remove('hidden');
  const logLines = [];
  const log = (msg) => { logLines.unshift(msg); status.textContent = logLines.slice(0, 200).join('\n'); };
  log(`Starting upload of ${files.length} files...`);
  btn.disabled = true;
  let success = 0, failed = 0, cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const i = cursor++; const file = files[i];
      try { await uploadOne(file, i + 1, files.length, log); success++; }
      catch (err) { failed++; log(`[${i+1}/${files.length}] ${file.name} — FAILED: ${err.message}`); }
    }
  }
  await Promise.all(Array(4).fill(0).map(worker));
  log(''); log(`Done. ${success} succeeded, ${failed} failed.`);
  btn.disabled = false;
}

async function uploadOne(file, idx, total, log) {
  const arrayBuffer = await file.arrayBuffer();
  const byteArray = new Uint8Array(arrayBuffer);
  let dataSet;
  try { dataSet = dicomParser.parseDicom(byteArray); } catch (err) { throw new Error('Not a valid DICOM file'); }
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
  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/dicom' }, body: arrayBuffer });
  if (!putRes.ok) throw new Error('PUT failed: HTTP ' + putRes.status);
  log(`[${idx}/${total}] ${file.name} — done`);
}

// ============================================================
// Viewer
// ============================================================

let currentStudyTitle = '';
let volumeReady = false;

async function openStudy(studyUID) {
  showViewer();
  applyModeUI();
  volumeReady = false;
  $('curvedMPRPanel').classList.add('hidden');
  curvedMPR.clearCurve();

  $('viewerTitle').textContent = 'Loading study...';
  $('viewerInfo').textContent = '';
  $('viewerProgress').textContent = '';

  try {
    $('viewerProgress').textContent = 'Initializing viewer...';
    await viewer.initViewer();

    $('viewerProgress').textContent = 'Fetching instance list...';
    const res = await fetch(`/api/list-instances?studyUID=${encodeURIComponent(studyUID)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { instances, description } = await res.json();

    if (!instances || instances.length === 0) {
      $('viewerTitle').textContent = 'No images found in this study';
      $('viewerProgress').textContent = '';
      return;
    }

    currentStudyTitle = description || studyUID;
    const modeLabel = viewer.isMobileDevice() ? '📱 Stack' : '🖥️ MPR (3-plane)';
    $('viewerTitle').innerHTML = `${escapeHtml(currentStudyTitle)} <span style="font-size:0.7em;color:#94a3b8;font-weight:normal;">— ${modeLabel}</span>`;
    $('viewerInfo').textContent = viewer.isMobileDevice() ? 'Loading...' : 'Loading volume...';
    $('viewerProgress').textContent = viewer.isMobileDevice() ? 'Loading first slice...' : 'Building 3D volume...';

    const total = instances.length;
    const elements = viewer.isMobileDevice()
      ? { stack: $('stackViewport') }
      : { axial: $('axialViewport'), sagittal: $('sagittalViewport'), coronal: $('coronalViewport') };

    const { mode } = await viewer.loadStudy(
      elements, instances,
      (loaded, tot) => {
        const pct = Math.round((loaded/tot)*100);
        if (loaded < tot) $('viewerProgress').textContent = `${loaded} / ${tot} slices (${pct}%)`;
        else { $('viewerProgress').textContent = 'All slices cached'; setTimeout(() => ($('viewerProgress').textContent = ''), 2500); }
      },
      (info) => {
        if (info == null) return;
        if (mode === 'mpr') $('viewerInfo').textContent = `${info.orientation || ''}: slice ${info.index + 1}`;
        else {
          $('viewerInfo').textContent = `Slice ${info.index + 1} of ${total}`;
          $('sliceSlider').value = info.index;
          $('sliceValue').textContent = `${info.index + 1} / ${total}`;
        }
      },
      () => {
        const wl = viewer.getWindowLevel();
        if (wl) $('overlayWL').textContent = `W: ${wl.windowWidth}  L: ${wl.windowCenter}`;
        const zoom = viewer.getZoom();
        if (zoom != null) $('overlayZoom').textContent = `Zoom: ${zoom}%`;
        // Redraw curve overlay on every render (viewport may have zoomed/panned)
        drawCurveOverlay();
      },
      // onVolumeReady — enable curved MPR button
      (volumeId) => {
        try {
          curvedMPR.loadVolumeInfo(volumeId);
          volumeReady = true;
          if (!viewer.isMobileDevice()) {
            $('curvedMPRPanel').classList.remove('hidden');
            $('drawCurveBtn').disabled = false;
            $('drawCurveBtn').textContent = 'Draw Arch Curve';
          }
          console.log('Volume ready for curved MPR');
        } catch (err) {
          console.error('Failed to load volume info:', err);
        }
      }
    );

    if (mode === 'stack') {
      const slider = $('sliceSlider');
      slider.max = total - 1; slider.value = 0;
      $('sliceValue').textContent = `1 / ${total}`;
      slider.addEventListener('input', () => viewer.goToSlice(parseInt(slider.value, 10)));
    }

    // Set up curve overlay canvas on the axial viewport (desktop only)
    if (mode === 'mpr') {
      setupCurveOverlayCanvas();
    }
  } catch (err) {
    $('viewerTitle').textContent = 'Failed to load: ' + err.message;
    $('viewerProgress').textContent = '';
    console.error('openStudy error:', err);
  }
}

// ============================================================
// Curve overlay canvas & interaction
// ============================================================

let curveOverlayCanvas = null;
let drawMode = false; // true when "Draw Arch" is active
let draggingIndex = -1;
let hoverIndex = -1;

function setupCurveOverlayCanvas() {
  const axialEl = $('axialViewport');
  if (!axialEl) return;

  // Remove any existing overlay
  const existing = axialEl.parentElement.querySelector('.curve-overlay-canvas');
  if (existing) existing.remove();

  // Add overlay canvas over the axial viewport
  const canvas = document.createElement('canvas');
  canvas.className = 'curve-overlay-canvas';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.pointerEvents = 'none'; // starts inactive; enabled in draw mode
  canvas.style.zIndex = '20';
  axialEl.parentElement.style.position = 'relative';
  axialEl.parentElement.appendChild(canvas);
  curveOverlayCanvas = canvas;

  syncOverlayCanvasSize();

  // Wire up mouse events on the overlay
  canvas.addEventListener('mousedown', onOverlayMouseDown);
  canvas.addEventListener('mousemove', onOverlayMouseMove);
  canvas.addEventListener('mouseup', onOverlayMouseUp);
  canvas.addEventListener('contextmenu', onOverlayContextMenu);

  window.addEventListener('resize', syncOverlayCanvasSize);
}

function syncOverlayCanvasSize() {
  if (!curveOverlayCanvas) return;
  const axialEl = $('axialViewport');
  if (!axialEl) return;
  const rect = axialEl.getBoundingClientRect();
  curveOverlayCanvas.width = rect.width;
  curveOverlayCanvas.height = rect.height;
  drawCurveOverlay();
}

function worldToCanvasForOverlay(worldPoint) {
  return viewer.axialWorldToCanvas(worldPoint);
}

function drawCurveOverlay() {
  if (!curveOverlayCanvas) return;
  const ctx = curveOverlayCanvas.getContext('2d');
  curvedMPR.drawCurveOverlay(
    ctx,
    curveOverlayCanvas.width,
    curveOverlayCanvas.height,
    worldToCanvasForOverlay,
    hoverIndex
  );
}

function onOverlayMouseDown(e) {
  if (!drawMode) return;
  e.preventDefault();
  const rect = curveOverlayCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // Check if we clicked an existing control point (start drag)
  const idx = curvedMPR.findNearestControlPoint(cx, cy, worldToCanvasForOverlay);
  if (idx >= 0) {
    draggingIndex = idx;
    return;
  }

  // Otherwise, add a new control point at this location (converted to world)
  const world = viewer.axialCanvasToWorld(cx, cy);
  if (world) {
    curvedMPR.addControlPoint(world);
    drawCurveOverlay();
    updateCurveStatus();
  }
}

function onOverlayMouseMove(e) {
  if (!drawMode) return;
  const rect = curveOverlayCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  if (draggingIndex >= 0) {
    const world = viewer.axialCanvasToWorld(cx, cy);
    if (world) {
      curvedMPR.updateControlPoint(draggingIndex, world);
      drawCurveOverlay();
    }
  } else {
    const idx = curvedMPR.findNearestControlPoint(cx, cy, worldToCanvasForOverlay);
    if (idx !== hoverIndex) {
      hoverIndex = idx;
      drawCurveOverlay();
    }
  }
}

function onOverlayMouseUp() {
  draggingIndex = -1;
}

function onOverlayContextMenu(e) {
  if (!drawMode) return;
  e.preventDefault();
  const rect = curveOverlayCanvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const idx = curvedMPR.findNearestControlPoint(cx, cy, worldToCanvasForOverlay);
  if (idx >= 0) {
    curvedMPR.removeControlPoint(idx);
    hoverIndex = -1;
    drawCurveOverlay();
    updateCurveStatus();
  }
}

// ============================================================
// Curved MPR button handlers
// ============================================================

function toggleDrawMode() {
  drawMode = !drawMode;
  const btn = $('drawCurveBtn');
  if (drawMode) {
    // Remember which axial slice we started on
    const axialSlice = viewer.getAxialCurrentSlice();
    if (axialSlice != null) curvedMPR.setAxialSlice(axialSlice);
    curveOverlayCanvas.style.pointerEvents = 'auto';
    btn.textContent = 'Stop Drawing';
    btn.classList.add('active-btn');
    $('curveHelp').classList.remove('hidden');
  } else {
    curveOverlayCanvas.style.pointerEvents = 'none';
    btn.textContent = 'Draw Arch Curve';
    btn.classList.remove('active-btn');
    $('curveHelp').classList.add('hidden');
  }
}

function clearCurve() {
  curvedMPR.clearCurve();
  drawCurveOverlay();
  updateCurveStatus();
  $('panoramaCanvas').getContext('2d').clearRect(0, 0, $('panoramaCanvas').width, $('panoramaCanvas').height);
  $('panoramaStatus').textContent = 'No curve drawn yet.';
}

function updateCurveStatus() {
  const n = curvedMPR.getControlPointCount();
  $('curvePointCount').textContent = `${n} point${n === 1 ? '' : 's'}`;
  $('renderPanoramaBtn').disabled = n < 2;
}

async function renderPanorama() {
  if (curvedMPR.getControlPointCount() < 2) return;
  const btn = $('renderPanoramaBtn');
  btn.disabled = true;
  $('panoramaStatus').textContent = 'Rendering panorama... (may take 1-3 sec)';

  try {
    const canvas = $('panoramaCanvas');
    const slabMm = parseInt($('slabThickness').value, 10);
    const wl = viewer.getWindowLevel() || { windowWidth: 3500, windowCenter: 1500 };

    // Yield to browser so status text renders
    await new Promise((r) => setTimeout(r, 50));

    const result = await curvedMPR.renderPanorama(canvas, {
      heightMm: 60,
      slabThicknessMm: slabMm,
      pixelsPerMm: 3,
      windowWidth: wl.windowWidth,
      windowCenter: wl.windowCenter,
    });

    $('panoramaStatus').textContent = `Panorama: ${Math.round(result.widthMm)} mm arch × ${result.heightMm} mm tall, slab ${slabMm} mm`;
  } catch (err) {
    console.error('Panorama render failed:', err);
    $('panoramaStatus').textContent = 'Error: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// Toolbar actions (unchanged)
// ============================================================

async function toggleFullscreen() {
  const container = document.querySelector('.viewer-workspace');
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
    } catch (err) { container.classList.add('pseudo-fullscreen'); }
  }
  setTimeout(() => { viewer.resize(); syncOverlayCanvasSize(); }, 250);
}

async function takeScreenshot() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = currentStudyTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) || 'study';
    await viewer.screenshot(`${safeTitle}_${timestamp}.png`);
  } catch (err) { alert('Screenshot failed: ' + err.message); }
}

// ============================================================
// Wire up events
// ============================================================

$('loginBtn').addEventListener('click', checkPassword);
$('passwordInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') checkPassword(); });
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
    const a = btn.dataset.action;
    if (a === 'rotate') viewer.rotateViewport();
    else if (a === 'flipH') viewer.flipH();
    else if (a === 'flipV') viewer.flipV();
    else if (a === 'invert') viewer.invert();
    else if (a === 'reset') viewer.reset();
    else if (a === 'fullscreen') toggleFullscreen();
    else if (a === 'screenshot') takeScreenshot();
  });
});

$$('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => viewer.applyPreset(btn.dataset.preset));
});

// Curved MPR buttons
$('drawCurveBtn').addEventListener('click', toggleDrawMode);
$('clearCurveBtn').addEventListener('click', clearCurve);
$('renderPanoramaBtn').addEventListener('click', renderPanorama);
$('slabThickness').addEventListener('change', () => {
  if (curvedMPR.getControlPointCount() >= 2) renderPanorama();
});

window.addEventListener('resize', () => viewer.resize());
window.addEventListener('resize', applyModeUI);
window.addEventListener('orientationchange', applyModeUI);

if (sessionStorage.getItem(PASSWORD_KEY)) {
  fetch('/api/verify', { headers: authHeaders() }).then((r) => { if (r.ok) enterApp(); });
}
