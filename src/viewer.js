// ============================================================
// Cornerstone3D v3 — Volume Viewer (Session 2b)
// Loads all instances as a true 3D volume, displays AXIAL orientation
// This is the foundation Session 2c will use to add MPR viewports
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
const TOOL_GROUP_ID = 'VOLUME_TOOL_GROUP';
const VIEWPORT_ID = 'CT_AXIAL';

// The volumeId MUST start with 'cornerstoneStreamingImageVolume:'
// This tells Cornerstone to use the streaming volume loader
const VOLUME_ID_PREFIX = 'cornerstoneStreamingImageVolume:';

let initialized = false;
let renderingEngine = null;
let toolGroup = null;
let currentVolumeId = null;
let currentImageIds = [];
let currentViewport = null;
let currentElement = null;

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
// Load a study as a 3D volume
// ============================================================

/**
 * @param {HTMLElement} element - The div container
 * @param {Array<{url: string}>} instances - Signed URLs for each DICOM instance
 * @param {(loaded, total) => void} onVolumeProgress - Reports slice-load progress
 * @param {(idx) => void} onSliceChange - Called when the axial slice changes
 * @param {(viewport) => void} onRender - Called after each render (for W/L overlay)
 */
export async function loadStudy(element, instances, onVolumeProgress, onSliceChange, onRender) {
  if (!initialized) throw new Error('Call initViewer() first');

  cleanup();

  currentElement = element;
  currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);
  currentVolumeId = VOLUME_ID_PREFIX + 'STUDY_' + Date.now();

  // Create rendering engine
  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  // Create an ORTHOGRAPHIC viewport (volume viewport with axial orientation)
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

  // Create/setup tool group
  try {
    ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  } catch (e) {}
  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);

  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(LengthTool.toolName);
  toolGroup.addTool(AngleTool.toolName);

  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

  // Default active tools
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

  // Create the volume — this pre-allocates memory and starts metadata fetch
  const volume = await volumeLoader.createAndCacheVolume(currentVolumeId, {
    imageIds: currentImageIds,
  });

  // Report progress as slices load into the volume
  if (onVolumeProgress) {
    onVolumeProgress(0, currentImageIds.length);
    let loaded = 0;
    element.addEventListener(Enums.Events.IMAGE_LOADED, () => {
      loaded++;
      if (loaded <= currentImageIds.length) {
        onVolumeProgress(loaded, currentImageIds.length);
      }
    });
  }

  // Start loading pixel data (progressive)
  volume.load();

  // Attach volume to viewport
  await setVolumesForViewports(
    renderingEngine,
    [{ volumeId: currentVolumeId }],
    [VIEWPORT_ID]
  );

  currentViewport.render();

  // Slice change event
  element.addEventListener(Enums.Events.CAMERA_MODIFIED, () => {
    if (onSliceChange) {
      try {
        const idx = currentViewport.getCurrentImageIdIndex();
        onSliceChange(idx);
      } catch (e) {}
    }
  });

  // Render event — updates W/L overlay
  if (onRender) {
    element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
      try { onRender(currentViewport); } catch (e) {}
    });
  }

  return { viewport: currentViewport, imageIds: currentImageIds };
}

// ============================================================
// Tool switching (toolbar buttons)
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
// Transform actions
// ============================================================

export function rotateViewport() {
  if (!currentViewport) return;
  try {
    const rotation = ((currentViewport.getRotation ? currentViewport.getRotation() : 0) + 90) % 360;
    currentViewport.setViewPresentation({ rotation });
    currentViewport.render();
  } catch (e) {
    console.warn('Rotate not supported on this viewport type:', e.message);
  }
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
// Presets — Window/Level for CT (uses HU values via voiRange)
// ============================================================

// [windowWidth, windowCenter] in HU
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
    // In a volume viewport, we scroll by setting the image index
    if (currentViewport.setImageIdIndex) {
      currentViewport.setImageIdIndex(index);
    }
  } catch (e) {
    console.warn('goToSlice failed:', e.message);
  }
}

export function getCurrentSliceIndex() {
  if (!currentViewport) return 0;
  try {
    return currentViewport.getCurrentImageIdIndex();
  } catch (e) {
    return 0;
  }
}

export function getNumberOfSlices() {
  if (!currentViewport) return 0;
  try {
    return currentViewport.getNumberOfSlices ? currentViewport.getNumberOfSlices() : currentImageIds.length;
  } catch (e) {
    return currentImageIds.length;
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
