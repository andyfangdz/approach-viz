import { Html } from '@react-three/drei';
import { memo, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ApproachPlate } from '@/lib/types';

const PLATE_RENDER_SCALE = 4;
const SURFACE_OFFSET_NM = -0.002;
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const DEG_TO_RAD = Math.PI / 180;
const METERS_TO_NM = 1 / 1852;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface GeoControlPoint {
  u: number;
  v: number;
  lat: number;
  lon: number;
}

interface GeoReferenceMetadata {
  mediaBox: [number, number, number, number];
  bbox: [number, number, number, number];
  controlPoints: GeoControlPoint[];
}

interface ApproachPlateSurfaceProps {
  plate: ApproachPlate;
  refLat: number;
  refLon: number;
  airportElevationFeet: number;
  verticalScale: number;
}

interface LatLonPoint {
  lat: number;
  lon: number;
}

function parseNumberArray(raw: string): number[] {
  const matches = raw.match(/-?\d+(?:\.\d+)?/g) || [];
  return matches.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value));
}

function extractGeoReferenceMetadata(bytes: Uint8Array): GeoReferenceMetadata | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const viewportStart = text.indexOf('/VP[');
  if (viewportStart < 0) return null;

  const viewportSlice = text.slice(viewportStart, Math.min(text.length, viewportStart + 24000));
  const bboxMatch = viewportSlice.match(/\/BBox\s*\[([^\]]+)\]/);
  const gptsMatch = viewportSlice.match(/\/GPTS\s*\[([^\]]+)\]/);
  const lptsMatch = viewportSlice.match(/\/LPTS\s*\[([^\]]+)\]/);
  const mediaBoxMatch = text.match(/\/MediaBox\s*\[([^\]]+)\]/);

  if (!bboxMatch || !gptsMatch || !lptsMatch || !mediaBoxMatch) return null;

  const mediaBoxValues = parseNumberArray(mediaBoxMatch[1]);
  const bboxValues = parseNumberArray(bboxMatch[1]);
  const gptsValues = parseNumberArray(gptsMatch[1]);
  const lptsValues = parseNumberArray(lptsMatch[1]);
  if (
    mediaBoxValues.length < 4 ||
    bboxValues.length < 4 ||
    gptsValues.length < 8 ||
    lptsValues.length < 8
  ) {
    return null;
  }

  const controlPoints: GeoControlPoint[] = [];
  const pointCount = Math.min(Math.floor(gptsValues.length / 2), Math.floor(lptsValues.length / 2));
  for (let i = 0; i < pointCount; i += 1) {
    controlPoints.push({
      u: lptsValues[i * 2],
      v: lptsValues[i * 2 + 1],
      lat: gptsValues[i * 2],
      lon: gptsValues[i * 2 + 1]
    });
  }

  if (controlPoints.length < 4) return null;

  return {
    mediaBox: [mediaBoxValues[0], mediaBoxValues[1], mediaBoxValues[2], mediaBoxValues[3]],
    bbox: [bboxValues[0], bboxValues[1], bboxValues[2], bboxValues[3]],
    controlPoints: controlPoints.slice(0, 4)
  };
}

function solveLinearSystem4(equations: number[][]): [number, number, number, number] | null {
  const matrix = equations.map((row) => row.slice());
  for (let pivot = 0; pivot < 4; pivot += 1) {
    let maxRow = pivot;
    for (let candidate = pivot + 1; candidate < 4; candidate += 1) {
      if (Math.abs(matrix[candidate][pivot]) > Math.abs(matrix[maxRow][pivot])) {
        maxRow = candidate;
      }
    }

    if (Math.abs(matrix[maxRow][pivot]) < 1e-8) return null;
    if (maxRow !== pivot) {
      [matrix[pivot], matrix[maxRow]] = [matrix[maxRow], matrix[pivot]];
    }

    const pivotValue = matrix[pivot][pivot];
    for (let col = pivot; col < 5; col += 1) {
      matrix[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < 4; row += 1) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let col = pivot; col < 5; col += 1) {
        matrix[row][col] -= factor * matrix[pivot][col];
      }
    }
  }

  return [matrix[0][4], matrix[1][4], matrix[2][4], matrix[3][4]];
}

function fitBilinearModel(
  points: GeoControlPoint[],
  valueSelector: (point: GeoControlPoint) => number
): [number, number, number, number] | null {
  const equations = points
    .slice(0, 4)
    .map((point) => [1, point.u, point.v, point.u * point.v, valueSelector(point)]);
  return solveLinearSystem4(equations);
}

function evaluateBilinear(coeff: [number, number, number, number], u: number, v: number): number {
  return coeff[0] + coeff[1] * u + coeff[2] * v + coeff[3] * u * v;
}

function latLonToLocal(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number
): { x: number; z: number } {
  const phi = refLat * DEG_TO_RAD;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const denom = Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const primeVerticalMeters = WGS84_SEMI_MAJOR_METERS / denom;
  const meridionalMeters = (WGS84_SEMI_MAJOR_METERS * (1 - WGS84_E2)) / (denom * denom * denom);

  const dLatRad = (lat - refLat) * DEG_TO_RAD;
  const dLonRad = (lon - refLon) * DEG_TO_RAD;
  const x = dLonRad * primeVerticalMeters * cosPhi * METERS_TO_NM;
  const z = -(dLatRad * meridionalMeters * METERS_TO_NM);
  return { x, z };
}

function altToBaseY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE;
}

function buildPlateGeometry(
  corners: [LatLonPoint, LatLonPoint, LatLonPoint, LatLonPoint],
  refLat: number,
  refLon: number,
  surfaceY: number
): THREE.BufferGeometry {
  const sw = latLonToLocal(corners[0].lat, corners[0].lon, refLat, refLon);
  const se = latLonToLocal(corners[1].lat, corners[1].lon, refLat, refLon);
  const ne = latLonToLocal(corners[2].lat, corners[2].lon, refLat, refLon);
  const nw = latLonToLocal(corners[3].lat, corners[3].lon, refLat, refLon);

  const positions = new Float32Array([
    sw.x,
    surfaceY,
    sw.z,
    se.x,
    surfaceY,
    se.z,
    ne.x,
    surfaceY,
    ne.z,
    nw.x,
    surfaceY,
    nw.z
  ]);

  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

async function renderPlateCanvas(
  bytes: Uint8Array,
  mediaBox: [number, number, number, number],
  bbox: [number, number, number, number]
): Promise<HTMLCanvasElement> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_SRC) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes
  });
  const pdf = await loadingTask.promise;

  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: PLATE_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create rendering context');
    }

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const mediaWidth = mediaBox[2] - mediaBox[0];
    const mediaHeight = mediaBox[3] - mediaBox[1];
    const scaleX = canvas.width / mediaWidth;
    const scaleY = canvas.height / mediaHeight;

    const cropX = Math.max(0, Math.floor((bbox[0] - mediaBox[0]) * scaleX));
    const cropY = Math.max(0, Math.floor((mediaBox[3] - bbox[3]) * scaleY));
    const cropWidth = Math.max(1, Math.floor((bbox[2] - bbox[0]) * scaleX));
    const cropHeight = Math.max(1, Math.floor((bbox[3] - bbox[1]) * scaleY));

    const safeWidth = Math.max(1, Math.min(cropWidth, canvas.width - cropX));
    const safeHeight = Math.max(1, Math.min(cropHeight, canvas.height - cropY));
    const cropped = document.createElement('canvas');
    cropped.width = safeWidth;
    cropped.height = safeHeight;
    const croppedContext = cropped.getContext('2d');
    if (!croppedContext) {
      throw new Error('Unable to create crop context');
    }

    croppedContext.drawImage(
      canvas,
      cropX,
      cropY,
      safeWidth,
      safeHeight,
      0,
      0,
      safeWidth,
      safeHeight
    );

    return cropped;
  } finally {
    await pdf.destroy();
  }
}

export const ApproachPlateSurface = memo(function ApproachPlateSurface({
  plate,
  refLat,
  refLon,
  airportElevationFeet,
  verticalScale
}: ApproachPlateSurfaceProps) {
  const [plateTexture, setPlateTexture] = useState<THREE.CanvasTexture | null>(null);
  const [plateGeometry, setPlateGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadPlate() {
      setLoading(true);
      setError('');

      setPlateTexture((previous) => {
        previous?.dispose();
        return null;
      });
      setPlateGeometry((previous) => {
        previous?.dispose();
        return null;
      });

      try {
        const response = await fetch(
          `/api/faa-plate?cycle=${encodeURIComponent(plate.cycle)}&file=${encodeURIComponent(plate.plateFile)}`
        );
        if (!response.ok) {
          throw new Error('Unable to load FAA plate');
        }

        const bytes = new Uint8Array(await response.arrayBuffer());
        const metadata = extractGeoReferenceMetadata(bytes);
        if (!metadata) {
          throw new Error('Missing geospatial metadata in FAA plate');
        }

        const latModel = fitBilinearModel(metadata.controlPoints, (point) => point.lat);
        const lonModel = fitBilinearModel(metadata.controlPoints, (point) => point.lon);
        if (!latModel || !lonModel) {
          throw new Error('Unable to derive plate georeferencing');
        }

        const corners: [LatLonPoint, LatLonPoint, LatLonPoint, LatLonPoint] = [
          { lat: evaluateBilinear(latModel, 0, 0), lon: evaluateBilinear(lonModel, 0, 0) },
          { lat: evaluateBilinear(latModel, 1, 0), lon: evaluateBilinear(lonModel, 1, 0) },
          { lat: evaluateBilinear(latModel, 1, 1), lon: evaluateBilinear(lonModel, 1, 1) },
          { lat: evaluateBilinear(latModel, 0, 1), lon: evaluateBilinear(lonModel, 0, 1) }
        ];

        const renderedCanvas = await renderPlateCanvas(bytes, metadata.mediaBox, metadata.bbox);
        const texture = new THREE.CanvasTexture(renderedCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        const surfaceY = altToBaseY(airportElevationFeet) + SURFACE_OFFSET_NM;
        const geometry = buildPlateGeometry(corners, refLat, refLon, surfaceY);

        if (cancelled) {
          texture.dispose();
          geometry.dispose();
          return;
        }

        setPlateTexture(texture);
        setPlateGeometry(geometry);
        setLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setLoading(false);
        setError(loadError instanceof Error ? loadError.message : 'Unable to load FAA plate');
      }
    }

    loadPlate();

    return () => {
      cancelled = true;
    };
  }, [plate.cycle, plate.plateFile, refLat, refLon, airportElevationFeet]);

  useEffect(
    () => () => {
      plateTexture?.dispose();
    },
    [plateTexture]
  );

  useEffect(
    () => () => {
      plateGeometry?.dispose();
    },
    [plateGeometry]
  );

  if (loading) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">Loading FAA plate...</div>
      </Html>
    );
  }

  if (error) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">{error}</div>
      </Html>
    );
  }

  if (!plateTexture || !plateGeometry) {
    return null;
  }

  return (
    <mesh geometry={plateGeometry} scale={[1, verticalScale, 1]}>
      <meshBasicMaterial
        map={plateTexture}
        transparent
        opacity={0.92}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
});
