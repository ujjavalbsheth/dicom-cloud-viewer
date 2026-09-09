// ============================================================
// DICOM Cloud Viewer — Session 1c
// Adds: toolbar, presets, measurements, transforms, mobile support
// ============================================================

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
  cleanupViewer();
  $('studiesView').classList.remove('hidden');
  $('uploadView').classList.add('hidden');
  $('viewerView').classList.add('hidden');
  loadStudies();
}

function showUpload() {
  cleanupViewer();
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
    dataSet = window.dicomParser.parseDicom(byteArray);
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

let cornerstoneInited = false;
let currentImageIds = [];
let currentElement = null;
let currentStudyTitle = '';

function initCornerstone() {
  if (cornerstoneInited) return;
  const cornerstone = window.cornerstone;
  const cornerstoneTools = window.cornerstoneTools;
  const cornerstoneMath = window.cornerstoneMath;
  const cornerstoneWADOImageLoader = window.cornerstoneWADOImageLoader;
  const dicomParser = window.dicomParser;
  const Hammer = window.Hammer;

  if (!cornerstone || !cornerstoneWADOImageLoader) {
    throw new Error('Cornerstone libraries did not load from CDN');
  }

  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
  cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
  cornerstoneTools.external.cornerstone = cornerstone;
  cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
  cornerstoneTools.external.Hammer = Hammer;

  cornerstoneTools.init({
    showSVGCursors: true,
    touchEnabled: true,
  });

  cornerstoneWADOImageLoader.webWorkerManager.initialize({
    maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
    startWebWorkersOnDemand: true,
    taskConfiguration: { decodeTask: { initializeCodecsOnStartup: false } },
  });

  cornerstoneInited = true;
}

function cleanupViewer() {
  if (!currentElement || !window.cornerstone) return;
  try {
    window.cornerstone.disable(currentElement);
  } catch (e) {}
  currentElement = null;
  currentImageIds = [];
}

// Presets: [windowWidth, windowCenter]
const PRESETS = {
  bone: [2000, 400],
  softTissue: [400, 40],
  teeth: [3500, 1500],
  air: [2000, -500],
};

async function openStudy(studyUID) {
  showViewer();
  $('viewerTitle').textContent = 'Loading study...';
  $('viewerInfo').textContent = '';
  $('viewerProgress').textContent = '';

  try {
    initCornerstone();
    const res = await fetch(`/api/list-instances?studyUID=${encodeURIComponent(studyUID)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { instances, description } = await res.json();
    if (!instances || instances.length === 0) {
      $('viewerTitle').textContent = 'No images found in this study';
      return;
    }

    currentStudyTitle = description || studyUID;
    $('viewerTitle').textContent = currentStudyTitle;
    $('viewerInfo').textContent = `Slice 1 of ${instances.length}`;

    currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);
    const cornerstone = window.cornerstone;
    const cornerstoneTools = window.cornerstoneTools;
    const element = $('dicomViewport');
    currentElement = element;

    cornerstone.enable(element);

    $('viewerProgress').textContent = 'Loading first slice...';
    const firstImage = await cornerstone.loadAndCacheImage(currentImageIds[0]);
    cornerstone.displayImage(element, firstImage);
    $('viewerProgress').textContent = '';

    // Set up stack for scrolling
    const stack = { currentImageIdIndex: 0, imageIds: currentImageIds };
    cornerstoneTools.clearToolState(element, 'stack');
    cornerstoneTools.addStackStateManager(element, ['stack']);
    cornerstoneTools.addToolState(element, 'stack', stack);

    // Register all tools
    const tools = [
      { tool: cornerstoneTools.WwwcTool, name: 'Wwwc' },
      { tool: cornerstoneTools.PanTool, name: 'Pan' },
      { tool: cornerstoneTools.ZoomTool, name: 'Zoom' },
      { tool: cornerstoneTools.StackScrollTool, name: 'StackScroll' },
      { tool: cornerstoneTools.StackScrollMouseWheelTool, name: 'StackScrollMouseWheel' },
      { tool: cornerstoneTools.LengthTool, name: 'Length' },
      { tool: cornerstoneTools.AngleTool, name: 'Angle' },
    ];
    tools.forEach((t) => cornerstoneTools.addTool(t.tool));

    // Mouse wheel always scrolls slices regardless of active tool
    cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

    // Default active tool: Window/Level
    setActiveTool('Wwwc');

    // Set up slice slider
    const slider = $('sliceSlider');
    slider.max = instances.length - 1;
    slider.value = 0;
    $('sliceValue').textContent = `1 / ${instances.length}`;

    slider.addEventListener('input', () => {
      const idx = parseInt(slider.value, 10);
      cornerstoneTools.scrollToIndex(element, idx);
    });

    // Update UI on slice change (from any source: wheel, drag, slider)
    element.addEventListener('cornerstonenewimage', (e) => {
      const idx = currentImageIds.indexOf(e.detail.image.imageId);
      if (idx >= 0) {
        $('viewerInfo').textContent = `Slice ${idx + 1} of ${currentImageIds.length}`;
        slider.value = idx;
        $('sliceValue').textContent = `${idx + 1} / ${currentImageIds.length}`;
      }
    });

    // Update overlays on image render (W/L values, zoom)
    element.addEventListener('cornerstoneimagerendered', () => {
      try {
        const viewport = cornerstone.getViewport(element);
        if (viewport && viewport.voi) {
          const ww = Math.round(viewport.voi.windowWidth);
          const wc = Math.round(viewport.voi.windowCenter);
          $('overlayWL').textContent = `W: ${ww}  L: ${wc}`;
        }
        if (viewport && viewport.scale) {
          $('overlayZoom').textContent = `Zoom: ${Math.round(viewport.scale * 100)}%`;
        }
      } catch (e) {}
    });

    // Prefetch a bunch of slices in background so scrolling feels smooth
    currentImageIds.slice(1, 50).forEach((id) => {
      cornerstone.loadAndCacheImage(id).catch(() => {});
    });
  } catch (err) {
    $('viewerTitle').textContent = 'Failed to load: ' + err.message;
    console.error('openStudy error:', err);
  }
}

// ============================================================
// Toolbar: active-tool switching
// ============================================================

// Tools that use mouse-button + touch drag
const DRAG_TOOLS = ['Wwwc', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle'];

function setActiveTool(toolName) {
  if (!window.cornerstoneTools) return;
  const cornerstoneTools = window.cornerstoneTools;

  // Deactivate all drag tools first
  DRAG_TOOLS.forEach((name) => {
    try {
      cornerstoneTools.setToolPassive(name);
    } catch (e) {}
  });

  // Activate the selected tool for mouse button 1 + touch
  try {
    cornerstoneTools.setToolActive(toolName, {
      mouseButtonMask: 1,
      isTouchActive: true,
    });
  } catch (e) {
    console.error('setToolActive failed for', toolName, e);
  }

  // Middle-drag always pans, right-drag always zooms (on top of the primary tool)
  try {
    cornerstoneTools.setToolActive('Pan', { mouseButtonMask: 4 });
    cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 2 });
  } catch (e) {}

  // Update button UI
  $$('.tool-btn[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  });
}

// ============================================================
// Toolbar: transform actions
// ============================================================

function rotateViewport() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;
  const viewport = cornerstone.getViewport(currentElement);
  viewport.rotation = (viewport.rotation + 90) % 360;
  cornerstone.setViewport(currentElement, viewport);
}

function flipHorizontal() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;
  const viewport = cornerstone.getViewport(currentElement);
  viewport.hflip = !viewport.hflip;
  cornerstone.setViewport(currentElement, viewport);
}

function flipVertical() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;
  const viewport = cornerstone.getViewport(currentElement);
  viewport.vflip = !viewport.vflip;
  cornerstone.setViewport(currentElement, viewport);
}

function invertColors() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;
  const viewport = cornerstone.getViewport(currentElement);
  viewport.invert = !viewport.invert;
  cornerstone.setViewport(currentElement, viewport);
}

function resetView() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;
  cornerstone.reset(currentElement);
}

function applyPreset(name) {
  if (!currentElement || !PRESETS[name]) return;
  const cornerstone = window.cornerstone;
  const [ww, wc] = PRESETS[name];
  const viewport = cornerstone.getViewport(currentElement);
  viewport.voi.windowWidth = ww;
  viewport.voi.windowCenter = wc;
  cornerstone.setViewport(currentElement, viewport);
}

// Fullscreen with iOS fallback
async function toggleFullscreen() {
  const container = $('viewportContainer');
  if (!container) return;

  // Check if we're in real fullscreen or pseudo-fullscreen
  const isRealFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  const isPseudoFullscreen = container.classList.contains('pseudo-fullscreen');

  if (isRealFullscreen || isPseudoFullscreen) {
    // Exit
    if (document.fullscreenElement && document.exitFullscreen) {
      await document.exitFullscreen();
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
    container.classList.remove('pseudo-fullscreen');
  } else {
    // Enter — try real fullscreen first
    try {
      if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      } else {
        // iOS Safari fallback — use CSS pseudo-fullscreen
        container.classList.add('pseudo-fullscreen');
      }
    } catch (err) {
      // If real fullscreen fails, fall back to pseudo
      container.classList.add('pseudo-fullscreen');
    }
  }

  // Give the browser a moment, then trigger a resize so canvas fits
  setTimeout(() => {
    if (currentElement && window.cornerstone) {
      try {
        window.cornerstone.resize(currentElement);
      } catch (e) {}
    }
  }, 250);
}

async function takeScreenshot() {
  if (!currentElement) return;
  const cornerstone = window.cornerstone;

  // Get the canvas that Cornerstone rendered to
  const canvas = currentElement.querySelector('canvas');
  if (!canvas) {
    alert('Could not find canvas to capture');
    return;
  }

  try {
    // Convert canvas to blob and trigger download
    canvas.toBlob((blob) => {
      if (!blob) {
        alert('Failed to create screenshot');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeTitle = currentStudyTitle.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
      a.href = url;
      a.download = `${safeTitle}_${timestamp}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (err) {
    console.error('Screenshot error:', err);
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
$('dicomViewport').addEventListener('contextmenu', (e) => e.preventDefault());

// Tool buttons
$$('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setActiveTool(btn.dataset.tool));
});

// Action buttons
$$('.tool-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    if (action === 'rotate') rotateViewport();
    else if (action === 'flipH') flipHorizontal();
    else if (action === 'flipV') flipVertical();
    else if (action === 'invert') invertColors();
    else if (action === 'reset') resetView();
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'screenshot') takeScreenshot();
  });
});

// Preset buttons
$$('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

// Handle window resize (e.g. rotate device, fullscreen toggle)
window.addEventListener('resize', () => {
  if (currentElement && window.cornerstone) {
    try {
      window.cornerstone.resize(currentElement);
    } catch (e) {}
  }
});

// Auto-enter if session valid
if (sessionStorage.getItem(PASSWORD_KEY)) {
  fetch('/api/verify', { headers: authHeaders() }).then((r) => {
    if (r.ok) enterApp();
  });
}
