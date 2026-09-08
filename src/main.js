// ============================================================
// DICOM Cloud Viewer — Session 1b (Part 1: Upload)
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
  $('studiesView').classList.remove('hidden');
  $('uploadView').classList.add('hidden');
  loadStudies();
}

function showUpload() {
  $('studiesView').classList.add('hidden');
  $('uploadView').classList.remove('hidden');
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
      <div class="study-card">
        <div class="study-name">${escapeHtml(s.description || 'Untitled study')}</div>
        <div class="study-meta">
          ${s.fileCount} files · ${escapeHtml(s.modality || 'Unknown modality')} · ${formatSize(s.totalSize)}
        </div>
        <div class="study-uid">${escapeHtml(s.studyUID)}</div>
      </div>
    `
      )
      .join('');
  } catch (err) {
    listEl.innerHTML = `<div class="error">Failed to load studies: ${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
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

  let success = 0,
    failed = 0;
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
      studyUID,
      seriesUID,
      instanceUID,
      instanceNumber,
      modality,
      studyDescription,
      size: file.size,
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

if (sessionStorage.getItem(PASSWORD_KEY)) {
  fetch('/api/verify', { headers: authHeaders() }).then((r) => {
    if (r.ok) enterApp();
  });
}
