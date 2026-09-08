// ============================================================
// Cornerstone3D viewer module
// Session 1b Part 2: 2D stack viewer for CBCT slices
// ============================================================

import {
  RenderingEngine,
  Enums,
  init as coreInit,
  imageLoader,
  metaData,
} from '@cornerstonejs/core';
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  StackScrollTool,
  ZoomTool,
  PanTool,
  WindowLevelTool,
  Enums as ToolEnums,
} from '@cornerstonejs/tools';
import * as cornerstoneDICOMImageLoader from '@cornerstonejs/dicom-image-loader';
import dicomParser from 'dicom-parser';

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

let initialized = false;
let renderingEngine = null;
let toolGroup = null;

const RENDERING_ENGINE_ID = 'dicomRenderingEngine';
const TOOL_GROUP_ID = 'dicomToolGroup';
const VIEWPORT_ID = 'CT_STACK';

/**
 * Initialize Cornerstone3D + tools + DICOM image loader.
 * Safe to call multiple times.
 */
export async function initViewer() {
  if (initialized) return;

  // Core
  await coreInit();
  await toolsInit();

  // DICOM image loader init
  cornerstoneDICOMImageLoader.external.cornerstone = { imageLoader, metaData };
  cornerstoneDICOMImageLoader.external.dicomParser = dicomParser;

  cornerstoneDICOMImageLoader.configure({
    useWebWorkers: true,
    decodeConfig: {
      convertFloatPixelDataToInt: false,
    },
  });

  cornerstoneDICOMImageLoader.webWorkerManager.initialize({
    maxWebWorkers: Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
      },
    },
  });

  // Rendering engine
  renderingEngine = new RenderingEngine(RENDERING_ENGINE_ID);

  // Tools
  addTool(StackScrollTool);
  addTool(ZoomTool);
  addTool(PanTool);
  addTool(WindowLevelTool);

  toolGroup = ToolGroupManager.createToolGroup(TOOL_GROUP_ID);
  toolGroup.addTool(StackScrollTool.toolName);
  toolGroup.addTool(ZoomTool.toolName);
  toolGroup.addTool(PanTool.toolName);
  toolGroup.addTool(WindowLevelTool.toolName);

  // Mouse bindings
  toolGroup.setToolActive(WindowLevelTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Primary }],
  });
  toolGroup.setToolActive(PanTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Auxiliary }], // middle mouse
  });
  toolGroup.setToolActive(ZoomTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Secondary }], // right mouse
  });
  toolGroup.setToolActive(StackScrollTool.toolName, {
    bindings: [{ mouseButton: MouseBindings.Wheel }],
  });

  initialized = true;
}

/**
 * Load and display a stack of DICOM instances in the given element.
 * @param {HTMLElement} element - Container div for the viewport
 * @param {Array<{url: string}>} instances - Array of instance objects (with signed URLs)
 * @param {(loaded: number, total: number) => void} onProgress - Called during slice prefetch
 * @returns {Promise<{viewport: object, imageIds: string[]}>}
 */
export async function loadStudy(element, instances, onProgress) {
  if (!initialized) {
    throw new Error('Viewer not initialized. Call initViewer() first.');
  }

  // Build imageIds using wadouri: scheme + signed URL
  const imageIds = instances.map((inst) => `wadouri:${inst.url}`);

  // Enable the element as a viewport
  const viewportInput = {
    viewportId: VIEWPORT_ID,
    type: ViewportType.STACK,
    element,
  };

  renderingEngine.enableElement(viewportInput);
  const viewport = renderingEngine.getViewport(VIEWPORT_ID);

  // Attach the tool group to this viewport
  toolGroup.addViewport(VIEWPORT_ID, RENDERING_ENGINE_ID);

  // Set the stack (this starts loading the first image)
  await viewport.setStack(imageIds, 0);
  viewport.render();

  // Prefetch the remaining slices in the background so scrolling is smooth
  prefetchSlices(imageIds, onProgress);

  return { viewport, imageIds };
}

/**
 * Load slices into cache in the background.
 */
async function prefetchSlices(imageIds, onProgress) {
  const total = imageIds.length;
  let loaded = 1; // first already loading
  if (onProgress) onProgress(loaded, total);

  const CONCURRENCY = 6;
  let cursor = 1; // skip index 0

  async function worker() {
    while (cursor < total) {
      const i = cursor++;
      try {
        await imageLoader.loadAndCacheImage(imageIds[i]);
      } catch (err) {
        // Skip failed slices silently — user can still scroll
      }
      loaded++;
      if (onProgress) onProgress(loaded, total);
    }
  }

  await Promise.all(Array(CONCURRENCY).fill(0).map(worker));
}

/**
 * Return the current slice index (0-based).
 */
export function getCurrentSliceIndex() {
  if (!renderingEngine) return 0;
  const vp = renderingEngine.getViewport(VIEWPORT_ID);
  return vp?.getCurrentImageIdIndex() ?? 0;
}

/**
 * Disable the viewport and clean up (call when leaving viewer view).
 */
export function disableViewer() {
  if (!renderingEngine) return;
  try {
    renderingEngine.disableElement(VIEWPORT_ID);
  } catch (e) {
    // element already disabled — ignore
  }
}
