// Upload-ready traffic geometry, built in the traffic worker from the WASM
// render SoA so the main thread only copies finished buffers into GPU
// attributes. Kept free of `three` and the DOM for unit tests.

import { formatDataBlock } from '../tracon/data-block';

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

/** STARS HISTORY control range; the default is 5. */
export const SCOPE_MAX_HISTORY_DOTS = 10;
/**
 * Minimum ground spacing between consecutive history dots: about one radar
 * update (4.6 s) at a typical 250 kt approach-control speed.
 */
export const SCOPE_HISTORY_DOT_SPACING_NM = 0.3;

/** Display settings the worker needs to build scope buffers. */
export interface TrafficScopeOptions {
  /** History dots per target, 0 to `SCOPE_MAX_HISTORY_DOTS`. */
  historyDotCount: number;
  /** Predicted track line length in minutes of flight; 0 draws none. */
  predictedTrackMinutes: number;
}

export interface TrafficScopeSoA extends TrafficRenderSoA {
  altitudeFeet: Float32Array;
  groundSpeedKt: Float32Array;
  hexes: string[];
  callsignLabels: (string | null)[];
}

/**
 * The tracks' render hash mixed with the scope options, as one unsigned
 * 32-bit value: the client skips results whose hash it has already applied,
 * and the scope buffers change with HISTORY and PTL even when the tracks do not.
 */
export function scopeRenderHash(trackHash: number, options: TrafficScopeOptions): number {
  let hash = trackHash >>> 0;
  hash = Math.imul(hash ^ Math.round(options.historyDotCount), 0x9e3779b1);
  hash = Math.imul(hash ^ Math.round(options.predictedTrackMinutes * 100), 0x85ebca6b);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** TRACON-scope presentation of the present airborne tracks, in one order. */
export interface TrafficScopeBuffers {
  /** `x, y, z` per present airborne track. */
  targetPositions: Float32Array;
  /** ICAO hex per target, the key for forcing a full data block. */
  targetHexes: string[];
  /** Reported altitude per target (NaN when unreported), for the altitude filter. */
  targetAltitudeFeet: Float32Array;
  /** 1 when the target broadcasts a flight ID (treated as associated). */
  targetAssociated: Uint8Array;
  /** Data block line 1 (identity) per target. */
  dataBlockIdents: string[];
  /** Data block line 2 (altitude/speed) per target. */
  dataBlockFields: string[];
  /** `x, y, z, age` per history dot; age 0 is the newest dot of its track. */
  historyDots: Float32Array;
  /** Predicted track line segments (6 floats) for targets with speed. */
  predictedTrackSegments: Float32Array;
  /** Target-to-floor segments (6 floats). */
  altitudeStalkSegments: Float32Array;
}

/**
 * Builds the scope presentation for present airborne tracks (STARS altitude
 * filtering leaves surface traffic to the tower's surface display): history
 * dots resampled from the trail at a minimum ground spacing (newest first), a
 * predicted track line from heading and ground speed, an altitude stalk down
 * to `floorY`, and the two full data block lines. Which data block each
 * target shows is chosen on the main thread from the altitude and
 * association columns, so selecting a target or moving the altitude filter
 * needs no worker round trip.
 */
export function buildTrafficScopeBuffers(
  soa: TrafficScopeSoA,
  floorY: number,
  options: TrafficScopeOptions
): TrafficScopeBuffers {
  const { trackCount, markerPositions, headingDeg, flags, trailPointsFlat } = soa;
  const { trailOffsets, trailCounts, altitudeFeet, groundSpeedKt } = soa;
  const historyDotCount = Math.max(
    0,
    Math.min(SCOPE_MAX_HISTORY_DOTS, Math.round(options.historyDotCount))
  );
  const predictedTrackMinutes = Math.max(0, options.predictedTrackMinutes);
  const targetPositions: number[] = [];
  const targetHexes: string[] = [];
  const targetAltitudeFeet: number[] = [];
  const targetAssociated: number[] = [];
  const dataBlockIdents: string[] = [];
  const dataBlockFields: string[] = [];
  const historyDots: number[] = [];
  const predictedTrackSegments: number[] = [];
  const altitudeStalkSegments: number[] = [];
  const spacingSq = SCOPE_HISTORY_DOT_SPACING_NM * SCOPE_HISTORY_DOT_SPACING_NM;

  for (let track = 0; track < trackCount; track += 1) {
    if ((flags[track] & TRAFFIC_FLAG_IS_CURRENTLY_PRESENT) === 0) continue;
    if ((flags[track] & TRAFFIC_FLAG_IS_ON_GROUND) !== 0) continue;
    const x = markerPositions[track * 3];
    const y = markerPositions[track * 3 + 1];
    const z = markerPositions[track * 3 + 2];
    const [ident, fields] = formatDataBlock(
      soa.callsignLabels[track],
      soa.hexes[track] ?? '',
      altitudeFeet[track],
      groundSpeedKt[track]
    );
    targetPositions.push(x, y, z);
    targetHexes.push(soa.hexes[track] ?? '');
    targetAltitudeFeet.push(altitudeFeet[track]);
    targetAssociated.push(soa.callsignLabels[track]?.trim() ? 1 : 0);
    dataBlockIdents.push(ident);
    dataBlockFields.push(fields);

    let lastX = x;
    let lastZ = z;
    let dots = 0;
    const trailOffset = trailOffsets[track];
    for (let point = trailCounts[track] - 1; point >= 0; point -= 1) {
      if (dots >= historyDotCount) break;
      const base = (trailOffset + point) * 3;
      const px = trailPointsFlat[base];
      const pz = trailPointsFlat[base + 2];
      const dx = px - lastX;
      const dz = pz - lastZ;
      if (dx * dx + dz * dz < spacingSq) continue;
      historyDots.push(px, trailPointsFlat[base + 1], pz, dots);
      dots += 1;
      lastX = px;
      lastZ = pz;
    }

    altitudeStalkSegments.push(x, y, z, x, floorY, z);
    const speed = groundSpeedKt[track];
    if (predictedTrackMinutes > 0 && Number.isFinite(speed) && speed > 0) {
      const lengthNm = (speed / 60) * predictedTrackMinutes;
      const headingRad = (headingDeg[track] * Math.PI) / 180;
      predictedTrackSegments.push(
        x,
        y,
        z,
        x + Math.sin(headingRad) * lengthNm,
        y,
        z - Math.cos(headingRad) * lengthNm
      );
    }
  }

  return {
    targetPositions: new Float32Array(targetPositions),
    targetHexes,
    targetAltitudeFeet: new Float32Array(targetAltitudeFeet),
    targetAssociated: new Uint8Array(targetAssociated),
    dataBlockIdents,
    dataBlockFields,
    historyDots: new Float32Array(historyDots),
    predictedTrackSegments: new Float32Array(predictedTrackSegments),
    altitudeStalkSegments: new Float32Array(altitudeStalkSegments)
  };
}
