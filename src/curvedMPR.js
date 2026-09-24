// ============================================================
// Curved MPR Module (Session 3a)
// - Catmull-Rom spline through control points
// - Arc-length parameterization
// - Trilinear volume sampling
// - Panorama rendering (MIP-style with slab thickness)
// ============================================================

import { cache } from '@cornerstonejs/core';

// ============================================================
// State — the current curve
// ============================================================

let controlPoints = []; // [{x, y, z}] in patient/world coordinates
let axialSliceIndex = null; // The axial slice on which the curve was drawn (constant Z)
let cachedVolumeInfo = null; // Cached voxel data + geometry

// ============================================================
// Volume metadata cache
// ============================================================

/**
 * Reads volume from Cornerstone3D cache and exposes voxel data + geometry
 * @param {string} volumeId
 * @returns {Object} { data, dimensions, spacing, origin, direction, min, max }
 */
export function loadVolumeInfo(volumeId) {
  const volume = cache.getVolume(volumeId);
  if (!volume) throw new Error('Volume not found in cache: ' + volumeId);

  // Cornerstone3D v3+ uses voxelManager instead of getScalarData()
  let scalarData = null;
  try {
    if (volume.voxelManager && typeof volume.voxelManager.getCompleteScalarDataArray === 'function') {
      scalarData = volume.voxelManager.getCompleteScalarDataArray();
    } else if (typeof volume.getScalarData === 'function') {
      // Older API fallback
      scalarData = volume.getScalarData();
    } else if (volume.scalarData) {
      scalarData = volume.scalarData;
    }
  } catch (err) {
    console.warn('scalarData access threw:', err.message);
  }
  if (!scalarData || !scalarData.length) {
    throw new Error('Volume has no scalar data yet — is it fully loaded?');
  }

  cachedVolumeInfo = {
    data: scalarData,
    dimensions: volume.dimensions,
    spacing: volume.spacing,
    origin: volume.origin,
    direction: volume.direction || [1,0,0, 0,1,0, 0,0,1],
    min: 0,
    max: 0,
    volumeId,
  };

  // Sample min/max for W/L (subset for speed)
  let mn = Infinity, mx = -Infinity;
  const stride = Math.max(1, Math.floor(scalarData.length / 100000));
  for (let i = 0; i < scalarData.length; i += stride) {
    const v = scalarData[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  cachedVolumeInfo.min = mn;
  cachedVolumeInfo.max = mx;
  console.log('curvedMPR: volume loaded', {
    dimensions: volume.dimensions,
    spacing: volume.spacing,
    dataLength: scalarData.length,
    min: mn, max: mx,
  });
  return cachedVolumeInfo;
}

export function hasVolumeInfo() {
  return cachedVolumeInfo != null;
}

// ============================================================
// Control point management
// ============================================================

export function clearCurve() {
  controlPoints = [];
  axialSliceIndex = null;
}

export function setAxialSlice(sliceIndex) {
  axialSliceIndex = sliceIndex;
}

/**
 * Add a control point in WORLD coordinates (from click on axial viewport)
 */
export function addControlPoint(worldPoint) {
  controlPoints.push({ x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] });
}

export function getControlPoints() {
  return controlPoints.map(p => ({ ...p }));
}

export function updateControlPoint(index, worldPoint) {
  if (index < 0 || index >= controlPoints.length) return;
  controlPoints[index] = { x: worldPoint[0], y: worldPoint[1], z: worldPoint[2] };
}

export function removeControlPoint(index) {
  if (index < 0 || index >= controlPoints.length) return;
  controlPoints.splice(index, 1);
}

export function getControlPointCount() {
  return controlPoints.length;
}

// ============================================================
// Catmull-Rom spline
// ============================================================

/**
 * Sample a Catmull-Rom spline at parameter t in [0, 1] across ALL segments
 * @param {Array<{x,y,z}>} pts - control points
 * @param {number} t - global parameter [0..1]
 * @returns {{x,y,z}}
 */
function catmullRomSample(pts, t) {
  const n = pts.length;
  if (n === 0) return null;
  if (n === 1) return { ...pts[0] };
  if (n === 2) {
    // Linear interpolation
    return {
      x: pts[0].x + t * (pts[1].x - pts[0].x),
      y: pts[0].y + t * (pts[1].y - pts[0].y),
      z: pts[0].z + t * (pts[1].z - pts[0].z),
    };
  }

  // For Catmull-Rom, we need 4 control points per segment
  // We treat the segments as [P0..P1], [P1..P2], ..., [Pn-2..Pn-1]
  // with phantom points at the ends
  const segmentCount = n - 1;
  const scaledT = t * segmentCount;
  const seg = Math.min(Math.floor(scaledT), segmentCount - 1);
  const localT = scaledT - seg;

  // Pick 4 points, using clamped indices at boundaries
  const p0 = pts[Math.max(0, seg - 1)];
  const p1 = pts[seg];
  const p2 = pts[seg + 1];
  const p3 = pts[Math.min(n - 1, seg + 2)];

  return {
    x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, localT),
    y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, localT),
    z: catmullRom1D(p0.z, p1.z, p2.z, p3.z, localT),
  };
}

function catmullRom1D(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Approximate arc length by sampling many points
 * Returns { totalLength, cumulativeLengths, tValues } for arc-length reparameterization
 */
function computeArcLengthTable(pts, samples = 500) {
  const cumulative = [0];
  const tValues = [0];
  let prev = catmullRomSample(pts, 0);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const cur = catmullRomSample(pts, t);
    const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    cumulative.push(cumulative[i - 1] + dist);
    tValues.push(t);
    prev = cur;
  }
  return {
    totalLength: cumulative[samples],
    cumulativeLengths: cumulative,
    tValues,
  };
}

/**
 * Given a target arc-length distance, find the parameter t that produces it
 */
function tAtArcLength(table, targetLength) {
  const { cumulativeLengths, tValues } = table;
  // Binary search
  let lo = 0, hi = cumulativeLengths.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulativeLengths[mid] < targetLength) lo = mid;
    else hi = mid;
  }
  // Linear interpolate
  const segLen = cumulativeLengths[hi] - cumulativeLengths[lo];
  if (segLen === 0) return tValues[lo];
  const frac = (targetLength - cumulativeLengths[lo]) / segLen;
  return tValues[lo] + frac * (tValues[hi] - tValues[lo]);
}

/**
 * Sample the curve at N evenly-spaced points along its ARC LENGTH
 * Returns array of {point, tangent, normal} at each sample
 * @param {number} sampleCount - number of samples along the curve
 * @returns {Array<{point, tangent, normal}>}
 */
export function sampleCurveByArcLength(sampleCount) {
  if (controlPoints.length < 2) return [];
  const table = computeArcLengthTable(controlPoints);
  const samples = [];
  const totalLength = table.totalLength;
  if (totalLength < 0.001) return [];

  for (let i = 0; i < sampleCount; i++) {
    const targetLen = (i / (sampleCount - 1)) * totalLength;
    const t = tAtArcLength(table, targetLen);
    const point = catmullRomSample(controlPoints, t);

    // Estimate tangent via finite difference
    const eps = 1 / (sampleCount * 10);
    const tPlus = Math.min(1, t + eps);
    const tMinus = Math.max(0, t - eps);
    const pPlus = catmullRomSample(controlPoints, tPlus);
    const pMinus = catmullRomSample(controlPoints, tMinus);
    const tangent = normalize([
      pPlus.x - pMinus.x,
      pPlus.y - pMinus.y,
      pPlus.z - pMinus.z,
    ]);

    // Normal is perpendicular to tangent in the axial plane (Z-up)
    // Cross tangent with Z-axis gives an in-plane perpendicular
    const normal = normalize(cross(tangent, [0, 0, 1]));

    samples.push({ point: [point.x, point.y, point.z], tangent, normal });
  }
  return { samples, totalLength };
}

function normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  if (len < 1e-10) return [0, 0, 0];
  return [v[0]/len, v[1]/len, v[2]/len];
}

function cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

// ============================================================
// Trilinear volume sampling
// ============================================================

/**
 * Convert a world-space point to voxel indices (fractional).
 * Assumes axis-aligned volume (direction = identity), which is the common case for CT/CBCT.
 * If direction is not identity, this is an approximation.
 */
function worldToVoxel(world, info) {
  const [wx, wy, wz] = world;
  const [ox, oy, oz] = info.origin;
  const [sx, sy, sz] = info.spacing;
  return [
    (wx - ox) / sx,
    (wy - oy) / sy,
    (wz - oz) / sz,
  ];
}

/**
 * Sample the volume at a world-space point using trilinear interpolation
 * Returns the interpolated voxel value, or NaN if out of bounds
 */
function sampleVolumeTrilinear(world, info) {
  const [fx, fy, fz] = worldToVoxel(world, info);
  const [dx, dy, dz] = info.dimensions;

  if (fx < 0 || fx >= dx - 1 || fy < 0 || fy >= dy - 1 || fz < 0 || fz >= dz - 1) {
    return NaN;
  }

  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;

  const idx = (x, y, z) => x + dx * (y + dy * z);
  const d = info.data;

  const c000 = d[idx(x0, y0, z0)];
  const c100 = d[idx(x1, y0, z0)];
  const c010 = d[idx(x0, y1, z0)];
  const c110 = d[idx(x1, y1, z0)];
  const c001 = d[idx(x0, y0, z1)];
  const c101 = d[idx(x1, y0, z1)];
  const c011 = d[idx(x0, y1, z1)];
  const c111 = d[idx(x1, y1, z1)];

  const c00 = c000 * (1 - tx) + c100 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;

  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;

  return c0 * (1 - tz) + c1 * tz;
}

// ============================================================
// Panorama rendering (MIP along the arch)
// ============================================================

/**
 * Render a panoramic reformat of the volume along the current curve.
 * @param {HTMLCanvasElement} canvas - Where to draw
 * @param {Object} opts - {
 *   heightMm: vertical extent in mm (e.g., 60 for full jaw)
 *   slabThicknessMm: thickness of slab perpendicular to curve (5, 10, 20)
 *   pixelsPerMm: output resolution
 *   windowWidth, windowCenter: W/L for display
 * }
 */
export async function renderPanorama(canvas, opts = {}) {
  if (!cachedVolumeInfo) throw new Error('No volume loaded');
  if (controlPoints.length < 2) throw new Error('Draw at least 2 control points');

  const heightMm = opts.heightMm || 60;
  const slabThicknessMm = opts.slabThicknessMm || 10;
  const pixelsPerMm = opts.pixelsPerMm || 3;
  const windowWidth = opts.windowWidth || 3500;
  const windowCenter = opts.windowCenter || 1500;
  const slabSamples = Math.max(3, Math.round(slabThicknessMm)); // 1 sample per mm

  const { samples: curveSamples, totalLength } = sampleCurveByArcLength(
    Math.round(totalLengthEstimate() * pixelsPerMm)
  );
  if (!curveSamples || curveSamples.length === 0) throw new Error('Curve sampling failed');

  const outWidth = curveSamples.length;
  const outHeight = Math.round(heightMm * pixelsPerMm);

  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(outWidth, outHeight);
  const buf = imgData.data;

  // Z range around the axial slice where the curve was drawn
  // If no axial slice recorded, use the middle Z of the volume
  const info = cachedVolumeInfo;
  const [ox, oy, oz] = info.origin;
  const [sx, sy, sz] = info.spacing;
  const [dx, dy, dz] = info.dimensions;
  const centerZWorld = axialSliceIndex != null
    ? oz + axialSliceIndex * sz
    : oz + (dz / 2) * sz;

  // Half-height in world mm on each side of the reference Z
  // For dental panorama, we sample UP (superior) and DOWN (inferior) from the arch level
  const halfHeightMm = heightMm / 2;

  const wwHalf = windowWidth / 2;
  const wlLower = windowCenter - wwHalf;

  // For each column (x) in the output, sample along the arch curve
  // For each row (y), sample a different Z level
  // For slab thickness, MIP along the slab direction (perpendicular to curve in axial plane)
  for (let x = 0; x < outWidth; x++) {
    const sample = curveSamples[x];
    const px = sample.point[0];
    const py = sample.point[1];
    const nx = sample.normal[0];
    const ny = sample.normal[1];

    for (let y = 0; y < outHeight; y++) {
      // World Z for this row (top = superior, bottom = inferior)
      const worldZ = centerZWorld + halfHeightMm - (y / outHeight) * heightMm;

      // MIP through slab thickness in the normal direction
      let maxValue = -Infinity;
      for (let s = 0; s < slabSamples; s++) {
        const offset = (s / (slabSamples - 1) - 0.5) * slabThicknessMm;
        const wx = px + nx * offset;
        const wy = py + ny * offset;
        const val = sampleVolumeTrilinear([wx, wy, worldZ], info);
        if (!isNaN(val) && val > maxValue) maxValue = val;
      }

      // W/L map to 0-255
      let gray;
      if (maxValue === -Infinity) {
        gray = 0;
      } else {
        gray = Math.round(((maxValue - wlLower) / windowWidth) * 255);
        if (gray < 0) gray = 0;
        if (gray > 255) gray = 255;
      }

      const bufIdx = (y * outWidth + x) * 4;
      buf[bufIdx] = gray;
      buf[bufIdx + 1] = gray;
      buf[bufIdx + 2] = gray;
      buf[bufIdx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return { widthMm: totalLength, heightMm, outWidth, outHeight };
}

function totalLengthEstimate() {
  // Rough length from control points (used for output pixel width sizing)
  if (controlPoints.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < controlPoints.length; i++) {
    const dx = controlPoints[i].x - controlPoints[i-1].x;
    const dy = controlPoints[i].y - controlPoints[i-1].y;
    const dz = controlPoints[i].z - controlPoints[i-1].z;
    sum += Math.sqrt(dx*dx + dy*dy + dz*dz);
  }
  return sum * 1.15; // slight buffer for curve smoothing
}

// ============================================================
// Overlay: draw the curve on the axial viewport's overlay canvas
// ============================================================

/**
 * Given viewport-space projected points and their canvas pixel positions,
 * render curve + control point handles on a canvas overlay.
 * The caller provides the axial viewport and the mapping from world -> canvas pixel.
 */
export function drawCurveOverlay(ctx, canvasWidth, canvasHeight, worldToCanvas, activeIndex) {
  if (controlPoints.length === 0) return;

  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Draw curve
  if (controlPoints.length >= 2) {
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const SAMPLES = 200;
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const p = catmullRomSample(controlPoints, t);
      const [px, py] = worldToCanvas([p.x, p.y, p.z]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // Draw control points
  controlPoints.forEach((p, i) => {
    const [cx, cy] = worldToCanvas([p.x, p.y, p.z]);
    ctx.beginPath();
    ctx.arc(cx, cy, i === activeIndex ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = i === activeIndex ? '#f59e0b' : '#22d3ee';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Number label
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), cx, cy);
  });
}

/**
 * Find nearest control point to a canvas pixel (for click/drag)
 * @returns {number} index or -1 if none within threshold
 */
export function findNearestControlPoint(canvasX, canvasY, worldToCanvas, threshold = 15) {
  let nearest = -1;
  let nearestDist = threshold;
  controlPoints.forEach((p, i) => {
    const [cx, cy] = worldToCanvas([p.x, p.y, p.z]);
    const d = Math.sqrt((cx - canvasX) ** 2 + (cy - canvasY) ** 2);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = i;
    }
  });
  return nearest;
}
