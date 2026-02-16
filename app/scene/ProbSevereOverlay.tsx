import { Html } from '@react-three/drei';
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { parseNumberLike, parseStringLike } from '@/lib/parse-like';
import { earthCurvatureDropNm, latLonToLocal } from './approach-path/coordinates';

const FEET_PER_NM = 6076.12;
const POLL_INTERVAL_MS = 120_000;
const RETRY_INTERVAL_MS = 15_000;
const DEFAULT_MAX_RANGE_NM = 120;
const MIN_VECTOR_SPEED = 0.0001;
const VECTOR_CLEARANCE_NM = 0.08;
const MIN_VECTOR_LENGTH_NM = 2.2;
const MAX_VECTOR_LENGTH_NM = 7.4;
const MAX_LABEL_COUNT = 18;

interface ProbSevereOverlayProps {
  refLat: number;
  refLon: number;
  verticalScale: number;
  enabled?: boolean;
  maxRangeNm?: number;
  applyEarthCurvatureCompensation?: boolean;
}

type LonLatTuple = [lon: number, lat: number];

interface ProbSevereCellPayload {
  id: string;
  probability: number | null;
  topFeet: number | null;
  centroidLat: number;
  centroidLon: number;
  motionEast: number | null;
  motionSouth: number | null;
  polygon: LonLatTuple[];
}

interface ProbSeverePayload {
  generatedAt: string | null;
  validTime: string | null;
  sourceCellCount: number;
  cells: ProbSevereCellPayload[];
  error?: string;
}

interface RenderCell {
  id: string;
  probability: number | null;
  topFeet: number | null;
  topNm: number;
  hasTop: boolean;
  centroidX: number;
  centroidZ: number;
  ring: Array<{ x: number; z: number }>;
  vectorStartX: number;
  vectorStartZ: number;
  vectorDx: number;
  vectorDz: number;
  vectorLengthNm: number;
  hasVector: boolean;
}

interface RenderLabel {
  id: string;
  x: number;
  yNm: number;
  z: number;
  text: string;
}

function isSameLonLat(first: LonLatTuple, second: LonLatTuple): boolean {
  return Math.abs(first[0] - second[0]) < 1e-6 && Math.abs(first[1] - second[1]) < 1e-6;
}

function normalizeCell(rawCell: unknown): ProbSevereCellPayload | null {
  if (!rawCell || typeof rawCell !== 'object') return null;
  const cell = rawCell as Record<string, unknown>;
  const topFeet = parseNumberLike(cell.topFeet);
  const centroidLat = parseNumberLike(cell.centroidLat);
  const centroidLon = parseNumberLike(cell.centroidLon);
  if (
    centroidLat === null ||
    centroidLon === null ||
    centroidLat < -90 ||
    centroidLat > 90 ||
    centroidLon < -180 ||
    centroidLon > 180
  ) {
    return null;
  }

  const rawPolygon = Array.isArray(cell.polygon) ? cell.polygon : [];
  const polygon: LonLatTuple[] = [];
  for (const rawPoint of rawPolygon) {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) continue;
    const lon = Number(rawPoint[0]);
    const lat = Number(rawPoint[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    polygon.push([lon, lat]);
  }
  if (polygon.length < 3) return null;
  if (isSameLonLat(polygon[0], polygon[polygon.length - 1])) {
    polygon.pop();
  }
  if (polygon.length < 3) return null;

  return {
    id: parseStringLike(cell.id) ?? `${centroidLat.toFixed(3)}:${centroidLon.toFixed(3)}`,
    probability: parseNumberLike(cell.probability),
    topFeet: topFeet !== null && topFeet > 0 ? topFeet : null,
    centroidLat,
    centroidLon,
    motionEast: parseNumberLike(cell.motionEast),
    motionSouth: parseNumberLike(cell.motionSouth),
    polygon
  };
}

function normalizePayload(rawPayload: unknown): ProbSeverePayload {
  const payload =
    rawPayload && typeof rawPayload === 'object' ? (rawPayload as Record<string, unknown>) : {};
  const rawCells = Array.isArray(payload.cells) ? payload.cells : [];
  const cells: ProbSevereCellPayload[] = [];
  for (const rawCell of rawCells) {
    const normalized = normalizeCell(rawCell);
    if (!normalized) continue;
    cells.push(normalized);
  }
  return {
    generatedAt: parseStringLike(payload.generatedAt),
    validTime: parseStringLike(payload.validTime),
    sourceCellCount: Math.max(
      0,
      Math.round(parseNumberLike(payload.sourceCellCount) ?? cells.length)
    ),
    cells,
    error: parseStringLike(payload.error) ?? undefined
  };
}

function buildRequestUrl(refLat: number, refLon: number, maxRangeNm: number): string {
  const params = new URLSearchParams();
  params.set('lat', refLat.toFixed(6));
  params.set('lon', refLon.toFixed(6));
  params.set('maxRangeNm', String(maxRangeNm));
  return `/api/weather/nexrad/prob-severe?${params.toString()}`;
}

function buildLineGeometry(vertices: number[]): THREE.BufferGeometry | null {
  if (vertices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  return geometry;
}

function formatTopFeetLabel(topFeet: number): string {
  const kft = topFeet / 1000;
  if (kft >= 10) return `${Math.round(kft)}k`;
  return `${Math.round(kft * 10) / 10}k`;
}

export function ProbSevereOverlay({
  refLat,
  refLon,
  verticalScale,
  enabled = false,
  maxRangeNm = DEFAULT_MAX_RANGE_NM,
  applyEarthCurvatureCompensation = false
}: ProbSevereOverlayProps) {
  const [payload, setPayload] = useState<ProbSeverePayload | null>(null);

  useEffect(() => {
    if (!enabled) {
      setPayload(null);
      return;
    }

    setPayload(null);

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let activeAbortController: AbortController | null = null;

    const poll = async () => {
      activeAbortController = new AbortController();
      let nextDelayMs = POLL_INTERVAL_MS;
      try {
        const response = await fetch(buildRequestUrl(refLat, refLon, maxRangeNm), {
          cache: 'no-store',
          signal: activeAbortController.signal
        });
        if (!response.ok) {
          throw new Error(`ProbSevere request failed (${response.status})`);
        }
        const nextPayload = normalizePayload(await response.json());
        if (!cancelled) {
          setPayload((previousPayload) => {
            if (nextPayload.error && previousPayload && previousPayload.cells.length > 0) {
              return previousPayload;
            }
            return nextPayload;
          });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          nextDelayMs = RETRY_INTERVAL_MS;
        }
      } finally {
        activeAbortController = null;
        if (!cancelled) {
          timeoutId = setTimeout(poll, nextDelayMs);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (activeAbortController) activeAbortController.abort();
    };
  }, [enabled, refLat, refLon, maxRangeNm]);

  const renderCells = useMemo<RenderCell[]>(() => {
    if (!enabled || !payload?.cells?.length) return [];
    const next: RenderCell[] = [];
    for (const cell of payload.cells) {
      const centroidLocal = latLonToLocal(cell.centroidLat, cell.centroidLon, refLat, refLon);
      if (!Number.isFinite(centroidLocal.x) || !Number.isFinite(centroidLocal.z)) continue;
      const curvatureDropFeet = applyEarthCurvatureCompensation
        ? earthCurvatureDropNm(centroidLocal.x, centroidLocal.z, refLat) * FEET_PER_NM
        : 0;
      const correctedTopFeet =
        cell.topFeet !== null ? Math.max(0, cell.topFeet - curvatureDropFeet) : null;
      const hasTop = correctedTopFeet !== null && correctedTopFeet > 0;
      const topNm = hasTop ? correctedTopFeet / FEET_PER_NM : 0;
      if (!Number.isFinite(topNm)) continue;

      const ring: Array<{ x: number; z: number }> = [];
      for (const [lon, lat] of cell.polygon) {
        const local = latLonToLocal(lat, lon, refLat, refLon);
        if (!Number.isFinite(local.x) || !Number.isFinite(local.z)) continue;
        ring.push({ x: local.x, z: local.z });
      }
      if (ring.length < 3) continue;

      const motionEast = cell.motionEast ?? 0;
      const motionSouth = cell.motionSouth ?? 0;
      const motionSpeed = Math.hypot(motionEast, motionSouth);
      const vectorStartX = centroidLocal.x;
      const vectorStartZ = centroidLocal.z;
      const hasVector = motionSpeed > MIN_VECTOR_SPEED;
      const vectorDx = hasVector ? motionEast / motionSpeed : 0;
      const vectorDz = hasVector ? motionSouth / motionSpeed : 0;
      const vectorLengthNm = hasVector
        ? THREE.MathUtils.lerp(
            MIN_VECTOR_LENGTH_NM,
            MAX_VECTOR_LENGTH_NM,
            Math.min(1, motionSpeed / 24)
          )
        : 0;

      next.push({
        id: cell.id,
        probability: cell.probability,
        topFeet: correctedTopFeet,
        topNm,
        hasTop,
        centroidX: centroidLocal.x,
        centroidZ: centroidLocal.z,
        ring,
        vectorStartX,
        vectorStartZ,
        vectorDx,
        vectorDz,
        vectorLengthNm,
        hasVector
      });
    }
    return next;
  }, [enabled, payload?.cells, applyEarthCurvatureCompensation, refLat, refLon]);

  const geometryBundle = useMemo(() => {
    const topSegments: number[] = [];
    const baseSegments: number[] = [];
    const wallSegments: number[] = [];
    const vectorSegments: number[] = [];
    const labels: RenderLabel[] = [];

    for (const cell of renderCells) {
      const ringCount = cell.ring.length;
      for (let index = 0; index < ringCount; index += 1) {
        const current = cell.ring[index];
        const next = cell.ring[(index + 1) % ringCount];
        baseSegments.push(current.x, 0, current.z, next.x, 0, next.z);
        if (cell.hasTop) {
          topSegments.push(current.x, cell.topNm, current.z, next.x, cell.topNm, next.z);
        }
      }

      if (cell.hasTop) {
        const verticalStep = Math.max(1, Math.floor(ringCount / 14));
        for (let index = 0; index < ringCount; index += verticalStep) {
          const point = cell.ring[index];
          wallSegments.push(point.x, 0, point.z, point.x, cell.topNm, point.z);
        }
      }

      if (cell.hasVector) {
        const startY = (cell.hasTop ? cell.topNm : 0) + VECTOR_CLEARANCE_NM;
        const endX = cell.vectorStartX + cell.vectorDx * cell.vectorLengthNm;
        const endZ = cell.vectorStartZ + cell.vectorDz * cell.vectorLengthNm;
        vectorSegments.push(cell.vectorStartX, startY, cell.vectorStartZ, endX, startY, endZ);

        const arrowHeadLength = Math.min(1.2, Math.max(0.6, cell.vectorLengthNm * 0.28));
        const arrowHeadWidth = Math.min(0.7, Math.max(0.28, cell.vectorLengthNm * 0.18));
        const perpX = -cell.vectorDz;
        const perpZ = cell.vectorDx;
        const leftX = endX - cell.vectorDx * arrowHeadLength + perpX * arrowHeadWidth;
        const leftZ = endZ - cell.vectorDz * arrowHeadLength + perpZ * arrowHeadWidth;
        const rightX = endX - cell.vectorDx * arrowHeadLength - perpX * arrowHeadWidth;
        const rightZ = endZ - cell.vectorDz * arrowHeadLength - perpZ * arrowHeadWidth;
        vectorSegments.push(endX, startY, endZ, leftX, startY, leftZ);
        vectorSegments.push(endX, startY, endZ, rightX, startY, rightZ);
      }

      if (cell.hasTop) {
        labels.push({
          id: cell.id,
          x: cell.centroidX,
          yNm: cell.topNm + VECTOR_CLEARANCE_NM * 0.6,
          z: cell.centroidZ,
          text: formatTopFeetLabel(cell.topFeet ?? 0)
        });
      }
    }

    const selectedLabels = labels
      .slice()
      .sort((left, right) => right.yNm - left.yNm)
      .slice(0, MAX_LABEL_COUNT);

    return {
      topGeometry: buildLineGeometry(topSegments),
      baseGeometry: buildLineGeometry(baseSegments),
      wallGeometry: buildLineGeometry(wallSegments),
      vectorGeometry: buildLineGeometry(vectorSegments),
      labels: selectedLabels
    };
  }, [renderCells]);

  useEffect(
    () => () => {
      geometryBundle.topGeometry?.dispose();
      geometryBundle.baseGeometry?.dispose();
      geometryBundle.wallGeometry?.dispose();
      geometryBundle.vectorGeometry?.dispose();
    },
    [
      geometryBundle.topGeometry,
      geometryBundle.baseGeometry,
      geometryBundle.wallGeometry,
      geometryBundle.vectorGeometry
    ]
  );

  const hasRenderableData =
    Boolean(geometryBundle.topGeometry) ||
    Boolean(geometryBundle.baseGeometry) ||
    Boolean(geometryBundle.wallGeometry) ||
    Boolean(geometryBundle.vectorGeometry);
  if (!hasRenderableData) return null;

  return (
    <group scale={[1, verticalScale, 1]}>
      {geometryBundle.baseGeometry && (
        <lineSegments geometry={geometryBundle.baseGeometry} renderOrder={88}>
          <lineBasicMaterial
            color={0x5d2f12}
            transparent
            opacity={0.28}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      {geometryBundle.wallGeometry && (
        <lineSegments geometry={geometryBundle.wallGeometry} renderOrder={89}>
          <lineBasicMaterial
            color={0xff8c42}
            transparent
            opacity={0.45}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      {geometryBundle.topGeometry && (
        <lineSegments geometry={geometryBundle.topGeometry} renderOrder={90}>
          <lineBasicMaterial
            color={0xffc166}
            transparent
            opacity={0.95}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      {geometryBundle.vectorGeometry && (
        <lineSegments geometry={geometryBundle.vectorGeometry} renderOrder={91}>
          <lineBasicMaterial
            color={0x7cf2ff}
            transparent
            opacity={0.95}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </lineSegments>
      )}
      {geometryBundle.labels.map((label) => (
        <Html
          key={`${label.id}:${label.text}`}
          position={[label.x, label.yNm, label.z]}
          sprite
          distanceFactor={8}
          transform
        >
          <div className="storm-cell-label">{label.text}</div>
        </Html>
      ))}
    </group>
  );
}
