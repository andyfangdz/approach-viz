// Upload-ready traffic geometry, built in the traffic worker from the WASM
// render SoA so the main thread only copies finished buffers into GPU
// attributes. Kept free of `three` and the DOM for unit tests.

export const TRAFFIC_FLAG_IS_CURRENTLY_PRESENT = 0x01;
export const TRAFFIC_FLAG_IS_ON_GROUND = 0x02;
/** Scene units from an aircraft marker to the tip of its heading tick. */
export const TRAFFIC_HEADING_TICK_NM = 0.2;

export interface TrafficRenderSoA {
  trackCount: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailPointsFlat: Float32Array;
  trailOffsets: Uint32Array;
  trailCounts: Uint32Array;
}

export interface TrafficDrawBuffers {
  /** Line-segment pairs (6 floats per segment) for every rendered trail. */
  trailSegments: Float32Array;
  /** Aircraft present in the current feed, in render-track order. */
  activeTrackIndices: Uint32Array;
  /** Column-major 4x4 translation per active track, `InstancedMesh` layout. */
  markerMatrices: Float32Array;
  /** Marker-to-heading-tip segment (6 floats) per active track. */
  headingSegments: Float32Array;
}

export function buildTrafficDrawBuffers(soa: TrafficRenderSoA): TrafficDrawBuffers {
  const { trackCount, markerPositions, headingDeg, flags, trailPointsFlat } = soa;
  const { trailOffsets, trailCounts } = soa;

  let segmentCount = 0;
  let activeCount = 0;
  for (let track = 0; track < trackCount; track += 1) {
    const pointCount = trailCounts[track];
    if (pointCount > 1) segmentCount += pointCount - 1;
    if ((flags[track] & TRAFFIC_FLAG_IS_CURRENTLY_PRESENT) !== 0) activeCount += 1;
  }

  const trailSegments = new Float32Array(segmentCount * 6);
  let offset = 0;
  for (let track = 0; track < trackCount; track += 1) {
    const trailOffset = trailOffsets[track];
    const pointCount = trailCounts[track];
    for (let point = 1; point < pointCount; point += 1) {
      const a = (trailOffset + point - 1) * 3;
      const b = (trailOffset + point) * 3;
      trailSegments[offset++] = trailPointsFlat[a];
      trailSegments[offset++] = trailPointsFlat[a + 1];
      trailSegments[offset++] = trailPointsFlat[a + 2];
      trailSegments[offset++] = trailPointsFlat[b];
      trailSegments[offset++] = trailPointsFlat[b + 1];
      trailSegments[offset++] = trailPointsFlat[b + 2];
    }
  }

  const activeTrackIndices = new Uint32Array(activeCount);
  const markerMatrices = new Float32Array(activeCount * 16);
  const headingSegments = new Float32Array(activeCount * 6);
  let active = 0;
  for (let track = 0; track < trackCount; track += 1) {
    if ((flags[track] & TRAFFIC_FLAG_IS_CURRENTLY_PRESENT) === 0) continue;
    const x = markerPositions[track * 3];
    const y = markerPositions[track * 3 + 1];
    const z = markerPositions[track * 3 + 2];
    activeTrackIndices[active] = track;

    const matrix = active * 16;
    markerMatrices[matrix] = 1;
    markerMatrices[matrix + 5] = 1;
    markerMatrices[matrix + 10] = 1;
    markerMatrices[matrix + 12] = x;
    markerMatrices[matrix + 13] = y;
    markerMatrices[matrix + 14] = z;
    markerMatrices[matrix + 15] = 1;

    const headingRad = (headingDeg[track] * Math.PI) / 180;
    const heading = active * 6;
    headingSegments[heading] = x;
    headingSegments[heading + 1] = y;
    headingSegments[heading + 2] = z;
    headingSegments[heading + 3] = x + Math.sin(headingRad) * TRAFFIC_HEADING_TICK_NM;
    headingSegments[heading + 4] = y;
    headingSegments[heading + 5] = z - Math.cos(headingRad) * TRAFFIC_HEADING_TICK_NM;
    active += 1;
  }

  return { trailSegments, activeTrackIndices, markerMatrices, headingSegments };
}
