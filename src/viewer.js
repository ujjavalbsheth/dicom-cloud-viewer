// ============================================================
// Cornerstone3D v3 — Dual-mode Viewer
// Mobile → STACK viewport (fast, works on WebGL-limited devices)
// Desktop → ORTHOGRAPHIC volume viewport (needed for MPR in Session 2c)
// ============================================================

import {
  init as coreInit,
  RenderingEngine,
  Enums,
  imageLoader,
  volumeLoader,
  setVolumesForViewports,
  cache,
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
  Enums as ToolEnums,
} from '@cornerstonejs/tools';
import * as cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = ToolEnums;

const RENDERING_ENGINE_ID = 'dicomRenderingEngine';
const TOOL_GROUP_ID = 'DUAL_TOOL_GROUP';
const VIEWPORT_ID = 'CT_MAIN';
const VOLUME_ID_PREFIX = 'cornerstoneStreamingImageVolume:';

let initialized = false;
let renderingEngine = null;
let toolGroup = null;
let currentVolumeId = null;
let currentImageIds = [];
let currentViewport = null;
let currentElement = null;
let currentMode = null; // 'stack' or 'volume'

// ============================================================
// Mobile detection
// ============================================================

export function isMobileDevice() {
  // Multi-signal detection: touch + coarse pointer + narrow screen
  const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const narrowScreen = window.innerWidth < 1024;
  // Consider mobile if it has touch AND (coarse pointer OR narrow screen)
  return hasTouch && (coarsePointer || narrowScreen);
}

export function getViewerMode() {
  return currentMode;
}

// ============================================================
// Initialization (call once)
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

  initialized = true;
}

// ============================================================
// Load study — picks stack or volume based on device
// ============================================================

export async function loadStudy(element, instances, onProgress, onSliceChange, onRender) {
  if (!initialized) throw new Error('Call initViewer() first');

  cleanup();
  currentElement = element;
  currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);
  currentMode = isMobileDevice() ? 'stack' : 'volume';

  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  // Create tool group (destroy old if exists)
  try { ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID); } catch (e) {}
  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(LengthTool.toolName);
  toolGroup.addTool(AngleTool.toolName);

  if (currentMode === 'stack') {
    await loadAsStack(element, onProgress, onSliceChange, onRender);
  } else {
    await loadAsVolume(element, onProgress, onSliceChange, onRender);
  }

  return { viewport: currentViewport, imageIds: currentImageIds, mode: currentMode };
}

// ============================================================
// Stack loading (mobile path)
// ============================================================

async function loadAsStack(element, onProgress, onSliceChange, onRender) {
  const viewportInput = {
    viewportId: VIEWPORT_ID,
    type: ViewportType.STACK,
    element,
    defaultOptions: { background: [0, 0, 0] },
  };

  renderingEngine.enableElement(viewportInput);
  currentViewport = renderingEngine.getViewport(VIEWPORT_ID);

  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
  configureToolBindings();

  // Load first slice
  await currentViewport.setStack(currentImageIds, 0);
  currentViewport.render();

  // Slice change event (STACK uses STACK_NEW_IMAGE)
  element.addEventListener(Enums.Events.STACK_NEW_IMAGE, () => {
    if (onSliceChange) {
      try {
        const idx = currentViewport.getCurrentImageIdIndex();
        onSliceChange(idx);
      } catch (e) {}
    }
  });

  if (onRender) {
    element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
      try { onRender(currentViewport); } catch (e) {}
    });
  }

  // Background prefetch
  prefetchStackSlices(currentImageIds, onProgress);
}

async function prefetchStackSlices(imageIds, onProgress) {
  const total = imageIds.length;
  let loaded = 1;
  if (onProgress) onProgress(loaded, total);
  const CONCURRENCY = 4; // lower on mobile
  let cursor = 1;

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      try {
        await imageLoader.loadAndCacheImage(imageIds[i]);
      } catch (e) {}
      loaded++;
      if (onProgress && loaded % 10 === 0) onProgress(loaded, total);
    }
  }
  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));
  if (onProgress) onProgress(total, total);
}

// ============================================================
// Volume loading (desktop path)
// ============================================================

async function loadAsVolume(element, onProgress, onSliceChange, onRender) {
  currentVolumeId = VOLUME_ID_PREFIX + 'STUDY_' + Date.now();

  const viewportInput = {
    viewportId: VIEWPORT_ID,
    type: ViewportType.ORTHOGRAPHIC,
    element,
    defaultOptions: {
      orientation: OrientationAxis.AXIAL,
      background: [0, 0, 0],
    },
  };

  renderingEngine.enableElement(viewportInput);
  currentViewport = renderingEngine.getViewport(VIEWPORT_ID);
  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);
  configureToolBindings();

  const volume = await volumeLoader.createAndCacheVolume(currentVolumeId, {
    imageIds: currentImageIds,
  });

  if (onProgress) {
    onProgress(0, currentImageIds.length);
    let loaded = 0;
    element.addEventListener(Enums.Events.IMAGE_LOADED, () => {
      loaded++;
      if (loaded <= currentImageIds.length) {
        onProgress(loaded, currentImageIds.length);
      }
    });
  }

  volume.load();

  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId: currentVolumeId }],
    [VIEWPORT_ID]
  );

  currentViewport.render();

  // Volume viewports use CAMERA_MODIFIED for slice changes
  element.addEventListener(Enums.Events.CAMERA_MODIFIED, () => {
    if (onSliceChange) {
      try {
        const idx = currentViewport.getCurrentImageIdIndex();
        if (idx != null) onSliceChange(idx);
      } catch (e) {}
    }
  });

  if (onRender) {
    element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
      try { onRender(currentViewport); } catch (e) {}
    });
  }
}

// ============================================================
// Shared: tool binding config
// ============================================================

function configureToolBindings() {
  toolGroup.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }],
  });
  toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }],
  });
  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });
}

// ============================================================
// Tool switching (shared between modes)
// ============================================================

const DRAG_TOOLS = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle'];

export function setActiveTool(toolName) {
  if (!toolGroup) return;
  DRAG_TOOLS.forEach((name) => {
    try { toolGroup.setToolPassive(name); } catch (e) {}
  });
  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  configureToolBindings();
}

// ============================================================
// Transform actions
// ============================================================

export function rotateViewport() {
  if (!currentViewport) return;
  try {
    const rotation = ((currentViewport.getRotation ? currentViewport.getRotation() : 0) + 90) % 360;
    currentViewport.setViewPresentation({ rotation });
    currentViewport.render();
  } catch (e) {}
}

export function flipH() {
  if (!currentViewport) return;
  const camera = currentViewport.getCamera();
  currentViewport.setCamera({ ...camera, flipHorizontal: !camera.flipHorizontal });
  currentViewport.render();
}

export function flipV() {
  if (!currentViewport) return;
  const camera = currentViewport.getCamera();
  currentViewport.setCamera({ ...camera, flipVertical: !camera.flipVertical });
  currentViewport.render();
}

export function invert() {
  if (!currentViewport) return;
  const properties = currentViewport.getProperties();
  currentViewport.setProperties({ invert: !properties.invert });
  currentViewport.render();
}

export function reset() {
  if (!currentViewport) return;
  currentViewport.resetCamera();
  try { currentViewport.resetProperties(); } catch (e) {}
  currentViewport.render();
}

// ============================================================
// Presets
// ============================================================

const PRESETS = {
  bone: [2000, 400],
  softTissue: [400, 40],
  teeth: [3500, 1500],
  air: [2000, -500],
};

export function applyPreset(name) {
  if (!currentViewport || !PRESETS[name]) return;
  const [ww, wc] = PRESETS[name];
  currentViewport.setProperties({
    voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 },
  });
  currentViewport.render();
}

// ============================================================
// Slice control
// ============================================================

export function goToSlice(index) {
  if (!currentViewport) return;
  try {
    if (currentViewport.setImageIdIndex) {
      currentViewport.setImageIdIndex(index);
    }
  } catch (e) {}
}

export function getCurrentSliceIndex() {
  if (!currentViewport) return 0;
  try {
    return currentViewport.getCurrentImageIdIndex();
  } catch (e) {
    return 0;
  }
}

// ============================================================
// Overlay readouts
// ============================================================

export function getWindowLevel() {
  if (!currentViewport) return null;
  try {
    const properties = currentViewport.getProperties();
    if (!properties || !properties.voiRange) return null;
    const { lower, upper } = properties.voiRange;
    return {
      windowWidth: Math.round(upper - lower),
      windowCenter: Math.round((upper + lower) / 2),
    };
  } catch (e) {
    return null;
  }
}

export function getZoom() {
  if (!currentViewport) return null;
  try {
    const camera = currentViewport.getCamera();
    return camera.parallelScale ? Math.round((1 / camera.parallelScale) * 100) : null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// Cleanup
// ============================================================

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
  currentViewport = null;
  currentElement = null;
  currentImageIds = [];
  currentVolumeId = null;
  currentMode = null;
}

// ============================================================
// Screenshot
// ============================================================

export async function screenshot(filename) {
  if (!currentElement) return;
  const canvas = currentElement.querySelector('canvas');
  if (!canvas) throw new Error('No canvas found');
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Failed to create blob'));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      resolve();
    }, 'image/png');
  });
}

export function resize() {
  if (renderingEngine) {
    try { renderingEngine.resize(); } catch (e) {}
  }
}

export function getImageIdCount() {
  return currentImageIds.length;
}
