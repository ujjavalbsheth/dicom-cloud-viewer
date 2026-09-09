// ============================================================
// Cornerstone3D v3 Stack Viewer
// Migrated from CDN Cornerstone v2 to npm-bundled Cornerstone3D
// ============================================================

import { init as coreInit, RenderingEngine, Enums, imageLoader, metaData } from '@cornerstonejs/core';
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

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

const RENDERING_ENGINE_ID = 'dicomRenderingEngine';
const TOOL_GROUP_ID = 'STACK_TOOL_GROUP';
const VIEWPORT_ID = 'CT_STACK';

let initialized = false;
let renderingEngine = null;
let toolGroup = null;
let currentImageIds = [];
let currentViewport = null;
let currentElement = null;

// ============================================================
// Initialization (call once)
// ============================================================

export async function initViewer() {
  if (initialized) return;

  // Core init
  await coreInit();
  await toolsInit();

  // DICOM image loader init — new v3 API
  cornerstoneDICOMImageLoader.init({
    maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
  });

  // Register tools once (not per-study)
  addTool(WindowLevelTool);
  addTool(PanTool);
  addTool(ZoomTool);
  addTool(StackScrollTool);
  addTool(LengthTool);
  addTool(AngleTool);

  initialized = true;
}

// ============================================================
// Load a study into the viewer
// ============================================================

/**
 * @param {HTMLElement} element - The div container
 * @param {Array<{url: string}>} instances - Signed URLs for each DICOM instance
 * @param {(loaded, total) => void} onProgress - Prefetch progress callback
 * @param {(idx) => void} onSliceChange - Called when the current slice changes
 * @param {(viewport) => void} onRender - Called after each render (for W/L overlay)
 * @returns {Promise<{viewport, imageIds}>}
 */
export async function loadStudy(element, instances, onProgress, onSliceChange, onRender) {
  if (!initialized) {
    throw new Error('Call initViewer() first');
  }

  // Clean up any previous viewport
  cleanup();

  currentElement = element;
  currentImageIds = instances.map((inst) => `wadouri:${inst.url}`);

  // Create rendering engine
  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  const viewportInput = {
    viewportId: VIEWPORT_ID,
    type: ViewportType.STACK,
    element,
    defaultOptions: {
      background: [0, 0, 0],
    },
  };

  renderingEngine.enableElement(viewportInput);
  currentViewport = renderingEngine.getViewport(VIEWPORT_ID);

  // Create tool group (destroy old one first if exists)
  try {
    ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  } catch (e) {}

  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);

  // Add all tools to the group
  toolGroup.addTool(WindowLevelTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(LengthTool.toolName);
  toolGroup.addTool(AngleTool.toolName);

  // Attach viewport
  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

  // Set default active tools:
  // Primary (left) = WindowLevel; Middle = Pan; Secondary (right) = Zoom
  // Mouse wheel is always StackScroll
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

  // Load and display the first image (this triggers download of first slice)
  await currentViewport.setStack(currentImageIds, 0);
  currentViewport.render();

  // Wire up slice change event
  const handleSliceChange = () => {
    const idx = currentViewport.getCurrentImageIdIndex();
    if (onSliceChange) onSliceChange(idx);
  };
  element.addEventListener(Enums.Events.STACK_NEW_IMAGE, handleSliceChange);

  // Wire up render event for W/L overlay
  if (onRender) {
    element.addEventListener(Enums.Events.IMAGE_RENDERED, () => {
      try {
        onRender(currentViewport);
      } catch (e) {}
    });
  }

  // Prefetch remaining slices in background
  prefetchSlices(currentImageIds, onProgress);

  return { viewport: currentViewport, imageIds: currentImageIds };
}

async function prefetchSlices(imageIds, onProgress) {
  const total = imageIds.length;
  let loaded = 1; // first one already loading
  if (onProgress) onProgress(loaded, total);

  const CONCURRENCY = 6;
  let cursor = 1;

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      try {
        await imageLoader.loadAndCacheImage(imageIds[i]);
      } catch (e) {
        // skip failed slice
      }
      loaded++;
      if (onProgress && loaded % 5 === 0) onProgress(loaded, total);
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));
  if (onProgress) onProgress(total, total);
}

// ============================================================
// Tool switching (for the toolbar buttons)
// ============================================================

const DRAG_TOOLS = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle'];

export function setActiveTool(toolName) {
  if (!toolGroup) return;

  // Deactivate all drag tools on the primary mouse button
  DRAG_TOOLS.forEach((name) => {
    try {
      toolGroup.setToolPassive(name);
    } catch (e) {}
  });

  // Activate the selected tool on primary mouse button
  toolGroup.setToolActive(toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });

  // Keep middle-drag = pan, right-drag = zoom, wheel = scroll always active
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
// Transform actions (rotate, flip, invert, reset)
// ============================================================

export function rotateViewport() {
  if (!currentViewport) return;
  const rotation = (currentViewport.getRotation() + 90) % 360;
  currentViewport.setViewPresentation({ rotation });
  currentViewport.render();
}

export function flipH() {
  if (!currentViewport) return;
  const camera = currentViewport.getCamera();
  const flip = { flipHorizontal: !camera.flipHorizontal };
  currentViewport.setCamera({ ...camera, ...flip });
  currentViewport.render();
}

export function flipV() {
  if (!currentViewport) return;
  const camera = currentViewport.getCamera();
  const flip = { flipVertical: !camera.flipVertical };
  currentViewport.setCamera({ ...camera, ...flip });
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
  currentViewport.resetProperties();
  currentViewport.render();
}

// ============================================================
// Presets — Window/Level
// ============================================================

// [windowWidth, windowCenter]
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
    voiRange: {
      lower: wc - ww / 2,
      upper: wc + ww / 2,
    },
  });
  currentViewport.render();
}

// ============================================================
// Slice control
// ============================================================

export function goToSlice(index) {
  if (!currentViewport) return;
  currentViewport.setImageIdIndex(index);
}

export function getCurrentSliceIndex() {
  if (!currentViewport) return 0;
  return currentViewport.getCurrentImageIdIndex();
}

// ============================================================
// Read viewport state (for overlay display)
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
    // Zoom in Cornerstone3D is derived from parallelScale
    // A larger parallelScale = zoomed out
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
    try {
      renderingEngine.destroy();
    } catch (e) {}
    renderingEngine = null;
  }
  try {
    ToolGroupManager.destroyToolGroup(TOOL_GROUP_ID);
  } catch (e) {}
  toolGroup = null;
  currentViewport = null;
  currentElement = null;
  currentImageIds = [];
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
      if (!blob) {
        reject(new Error('Failed to create blob'));
        return;
      }
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

// ============================================================
// Resize (call on window resize / fullscreen toggle)
// ============================================================

export function resize() {
  if (renderingEngine) {
    try {
      renderingEngine.resize();
    } catch (e) {}
  }
}

// Expose number of imageIds for slider
export function getImageIdCount() {
  return currentImageIds.length;
}
