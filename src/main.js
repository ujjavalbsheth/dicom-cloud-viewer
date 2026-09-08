// ============================================================
// DICOM Cloud Viewer — Session 1b Part 2
// Uses Cornerstone v2 loaded from CDN (window globals)
// ============================================================

const PASSWORD_KEY = 'dicomViewerAuth';
const $ = (id) => document.getElementById(id);

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
    const res = await fetch('/api/verify', {
      headers: { 'x-access-password': pwd },
    });
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
      listEl.innerHTML = `
        <div class="empty-state">
          No studies uploaded yet.<br>
          <button class="link" id="uploadFirst">Upload your first study →</button>
        </div>`;
      $('uploadFirst').addEventListener('click', showUpload);
      return;
    }

    listEl.innerHTML = studies
      .map(
        (s) => `
      <div class="study-card" data-uid="${escapeAttr(s.studyUID)}">
        <div class="study-name">${escapeHtml(s.description || 'Untitled study')}</div>
        <div class="study-meta">
          ${s.fileCount} files · ${escapeHtml(s.modality || 'Unknown modality')} · ${formatSize(s.totalSize)}
        </div>
        <div class="study-uid">${escapeHtml(s.studyUID)}</div>
      </div>
    `
      )
      .join('');

    document.querySelectorAll('.study-card').forEach((card) => {
      card.addEventListener('click', () => openStudy(card.dataset.uid));
    });
  } catch (err) {
    listEl.innerHTML = `<div class="error">Failed to load studies: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
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
  if (files.length === 0) {
    alert('Pick a folder or files first.');
    return;
  }

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
  const CONCURRENCY = 4;
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

  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));

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

  if (!studyUID || !instanceUID) {
    throw new Error('Missing required DICOM UIDs');
  }

  const instanceNumber = parseInt(dataSet.string('x00200013') || '0', 10);
  const modality = dataSet.string('x00080060') || '';
  const studyDescription = dataSet.string('x00081030') || '';

  log(`[${idx}/${total}] ${file.name} — requesting URL...`);

  const urlRes = await fetch('/api/upload-url', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      studyUID, seriesUID, instanceUID, instanceNumber,
      modality, studyDescription, size: file.size,
    }),
  });
  if (!urlRes.ok) {
    const errText = await urlRes.text();
    throw new Error('upload-url failed: ' + errText.slice(0, 100));
  }
  const { uploadUrl } = await urlRes.json();

  log(`[${idx}/${total}] ${file.name} — uploading ${formatSize(file.size)}...`);

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/dicom' },
    body: arrayBuffer,
  });
  if (!putRes.ok) {
    throw new Error('PUT failed: HTTP ' + putRes.status);
  }

  log(`[${idx}/${total}] ${file.name} — done`);
}

// ============================================================
// Viewer (Cornerstone v2 from CDN)
// ============================================================

let cornerstoneInited = false;
let currentImageIds = [];
let currentElement = null;

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

  cornerstoneTools.init({ showSVGCursors: true });

  cornerstoneWADOImageLoader.webWorkerManager.initialize({
    maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
      },
    },
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

async function openStudy(studyUID) {
  showViewer();
  $('viewerTitle').textContent = 'Loading study...';
  $('viewerInfo').textContent = '';
  $('viewerProgress').textContent = '';

  try {
    initCornerstone();

    // Fetch signed URLs for all instances
    const res = await fetch(
      `/api/list-instances?studyUID=${encodeURIComponent(studyUID)}`,
      { headers: authHeaders() }
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { instances, description } = await res.json();

    if (!instances || instances.length === 0) {
      $('viewerTitle').textContent = 'No images found in this study';
      return;
    }

    $('viewerTitle').textContent = description || studyUID;
    $('viewerInfo').textContent = `Slice 1 of ${instances.length}`;

    // Build imageIds with wadouri: prefix pointing to signed URLs
    currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);

    const cornerstone = window.cornerstone;
    const cornerstoneTools = window.cornerstoneTools;

    const element = $('dicomViewport');
    currentElement = element;

    cornerstone.enable(element);

    // Load and display the first image
    $('viewerProgress').textContent = 'Loading first slice...';
    const firstImage = await cornerstone.loadAndCacheImage(currentImageIds[0]);
    cornerstone.displayImage(element, firstImage);
    $('viewerProgress').textContent = '';

    // Set up the stack for scrolling
    const stack = {
      currentImageIdIndex: 0,
      imageIds: currentImageIds,
    };
    cornerstoneTools.clearToolState(element, 'stack');
    cornerstoneTools.addStackStateManager(element, ['stack']);
    cornerstoneTools.addToolState(element, 'stack', stack);

    // Register and activate tools
    const tools = [
      cornerstoneTools.StackScrollMouseWheelTool,
      cornerstoneTools.WwwcTool,
      cornerstoneTools.PanTool,
      cornerstoneTools.ZoomTool,
    ];
    tools.forEach((t) => cornerstoneTools.addTool(t));

    cornerstoneTools.setToolActive('StackScrollMouseWheel', {});
    cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
    cornerstoneTools.setToolActive('Pan', { mouseButtonMask: 4 });
    cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 2 });

    // Update slice counter on scroll
    element.addEventListener('cornerstonenewimage', (e) => {
      const idx = currentImageIds.indexOf(e.detail.image.imageId);
      if (idx >= 0) {
        $('viewerInfo').textContent = `Slice ${idx + 1} of ${currentImageIds.length}`;
      }
    });

    // Prefetch a few slices ahead so scrolling feels smooth
    let prefetched = 1;
    currentImageIds.slice(1, 30).forEach((id) => {
      cornerstone
        .loadAndCacheImage(id)
        .then(() => {
          prefetched++;
          if (prefetched % 5 === 0) {
            $('viewerProgress').textContent = `Prefetched ${prefetched} slices`;
            setTimeout(() => ($('viewerProgress').textContent = ''), 1500);
          }
        })
        .catch(() => {});
    });
  } catch (err) {
    $('viewerTitle').textContent = 'Failed to load: ' + err.message;
    console.error('openStudy error:', err);
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

// Prevent browser context menu on right-click over viewport
$('dicomViewport').addEventListener('contextmenu', (e) => e.preventDefault());

// Auto-enter if session valid
if (sessionStorage.getItem(PASSWORD_KEY)) {
  fetch('/api/verify', { headers: authHeaders() }).then((r) => {
    if (r.ok) enterApp();
  });
}
