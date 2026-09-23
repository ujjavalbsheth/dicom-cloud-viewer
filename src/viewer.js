// ============================================================
// Cornerstone3D v3 — MPR Viewer (Session 3a)
// Same as 2c + exposes volume/viewport getters for curved MPR module
// ============================================================

import {
  init as coreInit,
  RenderingEngine,
  Enums,
  imageLoader,
  volumeLoader,
  setVolumesForViewports,
  cache,
  utilities as coreUtilities,
} from '@cornerstonejs/core';
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  StackScrollTool,
  ZoomTool,
  PanTool,
  WindowLevelTool,
  LengthTool,
  AngleTool,
  CrosshairsTool,
  Enums as ToolEnums,
} from '@cornerstonejs/tools';
import * as cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = ToolEnums;

const RENDERING_ENGINE_ID = 'dicomRenderingEngine';
const TOOL_GROUP_ID = 'MPR_TOOL_GROUP';
const VIEWPORT_IDS = {
  AXIAL: 'CT_AXIAL',
  SAGITTAL: 'CT_SAGITTAL',
  CORONAL: 'CT_CORONAL',
};
const STACK_VIEWPORT_ID = 'CT_STACK';
const VOLUME_ID_PREFIX = 'cornerstoneStreamingImageVolume:';

let initialized = false;
let renderingEngine = null;
let toolGroup = null;
let currentVolumeId = null;
let currentImageIds = [];
let currentMode = null;
let currentViewports = {};
let activeViewportId = null;

// ============================================================
// Mobile detection
// ============================================================

export function isMobileDevice() {
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const narrowScreen = window.innerWidth < 1024;
  return hasTouch && (coarsePointer || narrowScreen);
}

export function getViewerMode() { return currentMode; }

// ============================================================
// Initialization
// ============================================================

export async function initViewer() {
  if (initialized) return;
  await coreInit();
  await toolsInit();
  cornerstoneDICOMImageLoader.init({
    maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
  });
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(StackScrollTool);
  addTool(LengthTool);
  addTool(AngleTool);
  addTool(CrosshairsTool);
  initialized = true;
}

// ============================================================
// Load study
// ============================================================

export async function loadStudy(elements, instances, onProgress, onSliceChange, onRender, onVolumeReady) {
  if (!initialized) throw new Error('Call initViewer() first');
  cleanup();
  currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);
  currentMode = isMobileDevice() ? 'stack' : 'mpr';
  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  try { ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID); } catch (e) {}
  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(LengthTool.toolName);
  toolGroup.addTool(AngleTool.toolName);

  if (currentMode === 'stack') {
    if (!elements.stack) throw new Error('Stack mode requires elements.stack');
    await loadAsStack(elements.stack, onProgress, onSliceChange, onRender);
  } else {
    if (!elements.axial || !elements.sagittal || !elements.coronal) {
      throw new Error('MPR mode requires elements.axial, .sagittal, .coronal');
    }
    toolGroup.addTool(CrosshairsTool.toolName);
    await loadAsMPR(elements, onProgress, onSliceChange, onRender, onVolumeReady);
  }
  return { mode: currentMode, imageIds: currentImageIds };
}

async function loadAsStack(element, onProgress, onSliceChange, onRender) {
  const viewportInput = {
    viewportId: STACK_VIEWPORT_ID,
    type: ViewportType.STACK,
    element,
    defaultOptions: { background: [0, 0, 0] },
  };
  renderingEngine.enableElement(viewportInput);
  const viewport = renderingEngine.getViewport(STACK_VIEWPORT_ID);
  currentViewports = { STACK: viewport };
  activeViewportId = STACK_VIEWPORT_ID;
  toolGroup.addViewport(STACK_VIEWPORT_ID, RENDERING_ENGINE_ID);
  configureToolBindings();
  await viewport.setStack(currentImageIds, 0);
  viewport.render();
  element.addEventListener(Enums.Events.STACK_NEW_IMAGE, () => {
    if (onSliceChange) {
      try {
        const idx = viewport.getCurrentImageIdIndex();
        onSliceChange({ viewportId: STACK_VIEWPORT_ID, index: idx });
      } catch (e) {}
    }
  });
  if (onRender) {
    element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
      try { onRender(viewport); } catch (e) {}
    });
  }
  prefetchStackSlices(currentImageIds, onProgress);
}

async function prefetchStackSlices(imageIds, onProgress) {
  const total = imageIds.length;
  let loaded = 1;
  if (onProgress) onProgress(loaded, total);
  let cursor = 1;
  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      try { await imageLoader.loadAndCacheImage(imageIds[i]); } catch (e) {}
      loaded++;
      if (onProgress && loaded % 10 === 0) onProgress(loaded, total);
    }
  }
  await Promise.all(Array(4).fill(0).map(worker));
  if (onProgress) onProgress(total, total);
}

async function loadAsMPR(elements, onProgress, onSliceChange, onRender, onVolumeReady) {
  currentVolumeId = VOLUME_ID_PREFIX + 'STUDY_' + Date.now();

  const viewportInputs = [
    { viewportId: VIEWPORT_IDS.AXIAL,    type: ViewportType.ORTHOGRAPHIC, element: elements.axial,
      defaultOptions: { orientation: OrientationAxis.AXIAL,    background: [0,0,0] } },
    { viewportId: VIEWPORT_IDS.SAGITTAL, type: ViewportType.ORTHOGRAPHIC, element: elements.sagittal,
      defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0,0,0] } },
    { viewportId: VIEWPORT_IDS.CORONAL,  type: ViewportType.ORTHOGRAPHIC, element: elements.coronal,
      defaultOptions: { orientation: OrientationAxis.CORONAL,  background: [0,0,0] } },
  ];

  renderingEngine.setViewports(viewportInputs);
  currentViewports = {
    AXIAL:    renderingEngine.getViewport(VIEWPORT_IDS.AXIAL),
    SAGITTAL: renderingEngine.getViewport(VIEWPORT_IDS.SAGITTAL),
    CORONAL:  renderingEngine.getViewport(VIEWPORT_IDS.CORONAL),
  };
  activeViewportId = VIEWPORT_IDS.AXIAL;

  toolGroup.addViewport(VIEWPORT_IDS.AXIAL,    RENDERING_ENGINE_ID);
  toolGroup.addViewport(VIEWPORT_IDS.SAGITTAL, RENDERING_ENGINE_ID);
  toolGroup.addViewport(VIEWPORT_IDS.CORONAL,  RENDERING_ENGINE_ID);
  configureToolBindings();

  const volume = await volumeLoader.createAndCacheVolume(currentVolumeId, {
    imageIds: currentImageIds,
  });

  const total = currentImageIds.length;
  if (onProgress) onProgress(0, total);

  // Poll the volume's cachedFrames array — Cornerstone3D v3 marks each frame as loaded here.
  // This is more reliable than listening for events across viewports.
  const poll = setInterval(() => {
    let loaded = 0;
    try {
      const cf = volume.cachedFrames;
      if (Array.isArray(cf)) {
        for (let i = 0; i < cf.length; i++) if (cf[i]) loaded++;
      }
    } catch (e) {}
    if (onProgress) onProgress(loaded, total);
    if (loaded >= total) {
      clearInterval(poll);
      console.log('Volume fully loaded, firing onVolumeReady');
      if (onVolumeReady) {
        try { onVolumeReady(currentVolumeId); } catch (e) { console.error('onVolumeReady error:', e); }
      }
    }
  }, 500);
  setTimeout(() => clearInterval(poll), 240000);

  // Kick off pixel loading. .load() returns a promise that resolves when ALL slices are in.
  volume.load(() => {
    // Callback fires per-frame during progressive loading (not needed here — poll handles it)
  }).then(() => {
    // Fires once all frames loaded — belt-and-braces alongside the poll
    clearInterval(poll);
    if (onProgress) onProgress(total, total);
    console.log('Volume.load() resolved, firing onVolumeReady');
    if (onVolumeReady) {
      try { onVolumeReady(currentVolumeId); } catch (e) { console.error('onVolumeReady error:', e); }
    }
  }).catch((err) => {
    console.error('volume.load() failed:', err);
  });

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId: currentVolumeId }],
    [VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL]
  );

  renderingEngine.renderViewports([
    VIEWPORT_IDS.AXIAL, VIEWPORT_IDS.SAGITTAL, VIEWPORT_IDS.CORONAL,
  ]);

  Object.entries(currentViewports).forEach(([label, vp]) => {
    vp.element.addEventListener(Enums.Events.CAMERA_MODIFIED, () => {
      if (onSliceChange) {
        try {
          const idx = vp.getCurrentImageIdIndex();
          onSliceChange({ viewportId: vp.id, orientation: label, index: idx });
        } catch (e) {}
      }
    });
    if (onRender) {
      vp.element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
        try { onRender(vp); } catch (e) {}
      });
    }
    vp.element.addEventListener('click', () => { activeViewportId = vp.id; });
  });
}

function configureToolBindings() {
  toolGroup.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  toolGroup.setToolActive(PanTool.toolName,          { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  toolGroup.setToolActive(ZoomTool.toolName,         { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  toolGroup.setToolActive(StackScrollTool.toolName,  { bindings: [{ mouseButton: MouseBindings.Wheel }] });
}

const DRAG_TOOLS = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'Crosshairs'];

export function setActiveTool(toolName) {
  if (!toolGroup) return;
  if (toolName === 'Crosshairs' && currentMode !== 'mpr') return;
  DRAG_TOOLS.forEach((name) => {
    try { toolGroup.setToolPassive(name); } catch (e) {}
  });
  toolGroup.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  configureToolBindings();
}

function getActiveViewport() {
  if (!renderingEngine || !activeViewportId) return null;
  try { return renderingEngine.getViewport(activeViewportId); } catch (e) { return null; }
}

export function rotateViewport() {
  const vp = getActiveViewport();
  if (!vp) return;
  try {
    const rotation = ((vp.getRotation ? vp.getRotation() : 0) + 90) % 360;
    vp.setViewPresentation({ rotation });
    vp.render();
  } catch (e) {}
}

export function flipH() {
  const vp = getActiveViewport();
  if (!vp) return;
  const camera = vp.getCamera();
  vp.setCamera({ ...camera, flipHorizontal: !camera.flipHorizontal });
  vp.render();
}
export function flipV() {
  const vp = getActiveViewport();
  if (!vp) return;
  const camera = vp.getCamera();
  vp.setCamera({ ...camera, flipVertical: !camera.flipVertical });
  vp.render();
}
export function invert() {
  Object.values(currentViewports).forEach((vp) => {
    const properties = vp.getProperties();
    vp.setProperties({ invert: !properties.invert });
    vp.render();
  });
}
export function reset() {
  Object.values(currentViewports).forEach((vp) => {
    vp.resetCamera();
    try { vp.resetProperties(); } catch (e) {}
    vp.render();
  });
}

const PRESETS = {
  bone: [2000, 400],
  softTissue: [400, 40],
  teeth: [3500, 1500],
  air: [2000, -500],
};

export function applyPreset(name) {
  if (!PRESETS[name]) return;
  const [ww, wc] = PRESETS[name];
  Object.values(currentViewports).forEach((vp) => {
    vp.setProperties({ voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 } });
    vp.render();
  });
}

export function goToSlice(index) {
  const vp = getActiveViewport();
  if (!vp) return;
  try { if (vp.setImageIdIndex) vp.setImageIdIndex(index); } catch (e) {}
}
export function getCurrentSliceIndex() {
  const vp = getActiveViewport();
  if (!vp) return 0;
  try { return vp.getCurrentImageIdIndex(); } catch (e) { return 0; }
}

export function getWindowLevel() {
  const vp = getActiveViewport();
  if (!vp) return null;
  try {
    const p = vp.getProperties();
    if (!p || !p.voiRange) return null;
    const { lower, upper } = p.voiRange;
    return { windowWidth: Math.round(upper - lower), windowCenter: Math.round((upper + lower) / 2) };
  } catch (e) { return null; }
}
export function getZoom() {
  const vp = getActiveViewport();
  if (!vp) return null;
  try {
    const c = vp.getCamera();
    return c.parallelScale ? Math.round((1 / c.parallelScale) * 100) : null;
  } catch (e) { return null; }
}

export function cleanup() {
  if (renderingEngine) {
    try { renderingEngine.destroy(); } catch (e) {}
    renderingEngine = null;
  }
  try { ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID); } catch (e) {}
  if (currentVolumeId) {
    try { cache.removeVolumeLoadObject(currentVolumeId); } catch (e) {}
  }
  toolGroup = null;
  currentViewports = {};
  activeViewportId = null;
  currentImageIds = [];
  currentVolumeId = null;
  currentMode = null;
}

export async function screenshot(filename) {
  const vp = getActiveViewport();
  if (!vp) return;
  const canvas = vp.element.querySelector('canvas');
  if (!canvas) throw new Error('No canvas found');
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to create blob'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url); resolve();
    }, 'image/png');
  });
}

export function resize() {
  if (renderingEngine) {
    try { renderingEngine.resize(); } catch (e) {}
  }
}

export function getImageIdCount() { return currentImageIds.length; }

// ============================================================
// Getters for curved MPR module (Session 3a)
// ============================================================

export function getVolumeId() {
  return currentVolumeId;
}

export function getAxialViewport() {
  return currentViewports.AXIAL || null;
}

export function getAxialElement() {
  return currentViewports.AXIAL ? currentViewports.AXIAL.element : null;
}

export function getAxialCurrentSlice() {
  if (!currentViewports.AXIAL) return null;
  try { return currentViewports.AXIAL.getCurrentImageIdIndex(); } catch (e) { return null; }
}

/**
 * Convert a canvas pixel (x, y) on the axial viewport to a world coordinate (with current Z of axial slice)
 */
export function axialCanvasToWorld(canvasX, canvasY) {
  const vp = currentViewports.AXIAL;
  if (!vp) return null;
  try {
    // Cornerstone3D: canvasToWorld([x, y]) returns [worldX, worldY, worldZ]
    return vp.canvasToWorld([canvasX, canvasY]);
  } catch (e) {
    return null;
  }
}

/**
 * Convert world coord to canvas pixel on axial viewport
 */
export function axialWorldToCanvas(worldPoint) {
  const vp = currentViewports.AXIAL;
  if (!vp) return null;
  try {
    return vp.worldToCanvas(worldPoint);
  } catch (e) {
    return null;
  }
}
