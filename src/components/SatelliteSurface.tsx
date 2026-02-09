import { Html } from '@react-three/drei';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin
} from '3d-tiles-renderer/plugins';
import { TilesAttributionOverlay, TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f';
import type { TilesRenderer as TilesRendererImpl } from '3d-tiles-renderer/three';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import type { ApproachPlate } from '@/lib/types';

const METERS_TO_NM = 1 / 1852;
const FEET_TO_METERS = 0.3048;
const FEET_TO_NM = 1 / 6076.12;
const SATELLITE_TILES_ERROR_TARGET = 12;
const PLATE_RENDER_SCALE = 4;
const DEG_TO_RAD = Math.PI / 180;
const WGS84_SEMI_MAJOR_METERS = 6378137;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_E2 = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

const EMPTY_TEXTURE = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
EMPTY_TEXTURE.needsUpdate = true;

interface SatelliteSurfaceProps {
  refLat: number;
  refLon: number;
  airportElevationFeet: number;
  geoidSeparationFeet: number;
  verticalScale: number;
  plateOverlay: ApproachPlate | null;
  onRuntimeError?: (message: string, error?: Error) => void;
}

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

interface PlateOverlayData {
  texture: THREE.CanvasTexture;
  homography: THREE.Matrix3;
}

interface PatchedMaterialUniforms {
  uPlateMap: { value: THREE.Texture };
  uPlateEnabled: { value: number };
  uPlateHomography: { value: THREE.Matrix3 };
}

interface PatchedMaterialState {
  uniforms: PatchedMaterialUniforms;
}

function parseNumberArray(raw: string): number[] {
  const matches = raw.match(/-?\d+(?:\.\d+)?/g) || [];
  return matches.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value));
}

function solveLinearSystem(equations: number[][]): number[] | null {
  const size = equations.length;
  if (size === 0) return null;
  const matrix = equations.map((row) => row.slice());
  if (!matrix.every((row) => row.length === size + 1)) return null;

  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    for (let candidate = pivot + 1; candidate < size; candidate += 1) {
      if (Math.abs(matrix[candidate][pivot]) > Math.abs(matrix[maxRow][pivot])) {
        maxRow = candidate;
      }
    }

    if (Math.abs(matrix[maxRow][pivot]) < 1e-10) return null;
    if (maxRow !== pivot) {
      [matrix[pivot], matrix[maxRow]] = [matrix[maxRow], matrix[pivot]];
    }

    const pivotValue = matrix[pivot][pivot];
    for (let col = pivot; col <= size; col += 1) {
      matrix[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let col = pivot; col <= size; col += 1) {
        matrix[row][col] -= factor * matrix[pivot][col];
      }
    }
  }

  return matrix.map((row) => row[size]);
}

function solveLinearSystem4(equations: number[][]): [number, number, number, number] | null {
  const solved = solveLinearSystem(equations);
  if (!solved || solved.length !== 4) return null;
  return [solved[0], solved[1], solved[2], solved[3]];
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
  const x = (dLonRad * primeVerticalMeters * cosPhi) / 1852;
  const z = (-dLatRad * meridionalMeters) / 1852;
  return { x, z };
}

function solveHomography(
  source: Array<{ x: number; z: number }>,
  target: Array<{ u: number; v: number }>
): THREE.Matrix3 | null {
  if (source.length !== 4 || target.length !== 4) return null;

  const equations: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const sx = source[i].x;
    const sz = source[i].z;
    const tu = target[i].u;
    const tv = target[i].v;
    equations.push([sx, sz, 1, 0, 0, 0, -tu * sx, -tu * sz, tu]);
    equations.push([0, 0, 0, sx, sz, 1, -tv * sx, -tv * sz, tv]);
  }

  const solved = solveLinearSystem(equations);
  if (!solved || solved.length !== 8) return null;
  return new THREE.Matrix3().set(
    solved[0],
    solved[1],
    solved[2],
    solved[3],
    solved[4],
    solved[5],
    solved[6],
    solved[7],
    1
  );
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

async function loadPlateOverlayData(
  plate: ApproachPlate,
  refLat: number,
  refLon: number
): Promise<PlateOverlayData> {
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

  const renderedCanvas = await renderPlateCanvas(bytes, metadata.mediaBox, metadata.bbox);
  const texture = new THREE.CanvasTexture(renderedCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const source = [
    latLonToLocal(
      evaluateBilinear(latModel, 0, 0),
      evaluateBilinear(lonModel, 0, 0),
      refLat,
      refLon
    ),
    latLonToLocal(
      evaluateBilinear(latModel, 1, 0),
      evaluateBilinear(lonModel, 1, 0),
      refLat,
      refLon
    ),
    latLonToLocal(
      evaluateBilinear(latModel, 1, 1),
      evaluateBilinear(lonModel, 1, 1),
      refLat,
      refLon
    ),
    latLonToLocal(
      evaluateBilinear(latModel, 0, 1),
      evaluateBilinear(lonModel, 0, 1),
      refLat,
      refLon
    )
  ];
  const target = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 }
  ];
  const homography = solveHomography(source, target);
  if (!homography) {
    texture.dispose();
    throw new Error('Unable to derive plate projection');
  }

  return { texture, homography };
}

function computeEcefToLocalNmFrame(
  latitudeDeg: number,
  longitudeDeg: number,
  heightMeters: number
): THREE.Matrix4 {
  const ecefOrigin = new Geodetic(radians(longitudeDeg), radians(latitudeDeg), heightMeters).toECEF(
    new THREE.Vector3()
  );
  const enuFrame = Ellipsoid.WGS84.getEastNorthUpFrame(ecefOrigin, new THREE.Matrix4());
  const ecefToEnu = enuFrame.clone().invert();
  // ENU (x=east,y=north,z=up) -> local scene (x=east,y=up,z=south)
  const enuToLocal = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
  return enuToLocal.multiply(ecefToEnu);
}

export const SatelliteSurface = memo(function SatelliteSurface({
  refLat,
  refLon,
  airportElevationFeet,
  geoidSeparationFeet,
  verticalScale,
  plateOverlay,
  onRuntimeError
}: SatelliteSurfaceProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
  const tilesRendererRef = useRef<TilesRendererImpl | null>(null);
  const loadErrorCountRef = useRef(0);
  const fatalErrorReportedRef = useRef(false);
  const patchedMaterialsRef = useRef<Set<THREE.Material>>(new Set());
  const patchedStateRef = useRef<WeakMap<THREE.Material, PatchedMaterialState>>(new WeakMap());
  const [plateTexture, setPlateTexture] = useState<THREE.CanvasTexture | null>(null);
  const [plateHomography, setPlateHomography] = useState<THREE.Matrix3 | null>(null);
  const [plateLoading, setPlateLoading] = useState(false);
  const [plateError, setPlateError] = useState('');
  const safeLat = Number.isFinite(refLat) ? refLat : 0;
  const safeLon = Number.isFinite(refLon) ? refLon : 0;
  const safeAirportElevationFeet = Number.isFinite(airportElevationFeet) ? airportElevationFeet : 0;
  const safeGeoidSeparationFeet = Number.isFinite(geoidSeparationFeet) ? geoidSeparationFeet : 0;

  const overlayEnabled = Boolean(plateOverlay && plateTexture && plateHomography);

  const ecefToLocal = useMemo(
    () =>
      computeEcefToLocalNmFrame(
        safeLat,
        safeLon,
        (safeAirportElevationFeet + safeGeoidSeparationFeet) * FEET_TO_METERS
      ),
    [safeLat, safeLon, safeAirportElevationFeet, safeGeoidSeparationFeet]
  );
  const airportElevationY = useMemo(
    () => safeAirportElevationFeet * FEET_TO_NM * verticalScale,
    [safeAirportElevationFeet, verticalScale]
  );
  const rendererKey = useMemo(
    () => `${apiKey}:${safeLat.toFixed(5)}:${safeLon.toFixed(5)}`,
    [apiKey, safeLat, safeLon]
  );

  useEffect(() => {
    let cancelled = false;
    const activePlate = plateOverlay;

    if (!activePlate) {
      setPlateLoading(false);
      setPlateError('');
      setPlateHomography(null);
      setPlateTexture((previous) => {
        previous?.dispose();
        return null;
      });
      return () => {
        cancelled = true;
      };
    }
    const resolvedPlate: ApproachPlate = activePlate;

    async function loadOverlay() {
      setPlateLoading(true);
      setPlateError('');
      setPlateHomography(null);
      setPlateTexture((previous) => {
        previous?.dispose();
        return null;
      });

      try {
        const overlayData = await loadPlateOverlayData(resolvedPlate, safeLat, safeLon);
        if (cancelled) {
          overlayData.texture.dispose();
          return;
        }
        setPlateTexture(overlayData.texture);
        setPlateHomography(overlayData.homography);
        setPlateLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setPlateLoading(false);
        setPlateError(
          loadError instanceof Error ? loadError.message : 'Unable to load FAA plate texture'
        );
      }
    }

    loadOverlay();
    return () => {
      cancelled = true;
    };
  }, [plateOverlay?.cycle, plateOverlay?.plateFile, safeLat, safeLon]);

  useEffect(
    () => () => {
      plateTexture?.dispose();
    },
    [plateTexture]
  );

  const syncPatchedMaterials = useCallback(() => {
    const textureValue = overlayEnabled && plateTexture ? plateTexture : EMPTY_TEXTURE;
    const enabledValue = overlayEnabled ? 1 : 0;
    const homographyValue = overlayEnabled && plateHomography ? plateHomography : null;

    for (const material of patchedMaterialsRef.current) {
      const state = patchedStateRef.current.get(material);
      if (!state) continue;
      state.uniforms.uPlateMap.value = textureValue;
      state.uniforms.uPlateEnabled.value = enabledValue;
      if (homographyValue) {
        state.uniforms.uPlateHomography.value.copy(homographyValue);
      } else {
        state.uniforms.uPlateHomography.value.identity();
      }
    }
  }, [overlayEnabled, plateTexture, plateHomography]);

  const patchMaterial = useCallback(
    (material: THREE.Material) => {
      if (patchedMaterialsRef.current.has(material)) return;
      const patchable = material as THREE.Material & {
        onBeforeCompile: (shader: any, renderer: THREE.WebGLRenderer) => void;
        customProgramCacheKey?: () => string;
      };
      const originalOnBeforeCompile = patchable.onBeforeCompile?.bind(patchable);
      const originalCustomProgramCacheKey = patchable.customProgramCacheKey?.bind(patchable);
      const uniforms: PatchedMaterialUniforms = {
        uPlateMap: { value: overlayEnabled && plateTexture ? plateTexture : EMPTY_TEXTURE },
        uPlateEnabled: { value: overlayEnabled ? 1 : 0 },
        uPlateHomography: {
          value:
            overlayEnabled && plateHomography
              ? plateHomography.clone()
              : new THREE.Matrix3().identity()
        }
      };

      patchable.onBeforeCompile = (shader, renderer) => {
        shader.uniforms.uPlateMap = uniforms.uPlateMap;
        shader.uniforms.uPlateEnabled = uniforms.uPlateEnabled;
        shader.uniforms.uPlateHomography = uniforms.uPlateHomography;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
varying vec3 vPlateWorldPos;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
vPlateWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uPlateMap;
uniform float uPlateEnabled;
uniform mat3 uPlateHomography;
varying vec3 vPlateWorldPos;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
if (uPlateEnabled > 0.5) {
  vec3 plateUvH = uPlateHomography * vec3(vPlateWorldPos.x, vPlateWorldPos.z, 1.0);
  if (abs(plateUvH.z) > 1e-5) {
    vec2 plateUv = plateUvH.xy / plateUvH.z;
    if (plateUv.x >= 0.0 && plateUv.x <= 1.0 && plateUv.y >= 0.0 && plateUv.y <= 1.0) {
      vec4 plateTexel = texture2D(uPlateMap, plateUv);
      float plateAlpha = clamp(plateTexel.a * 0.92, 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, plateTexel.rgb, plateAlpha);
    }
  }
}`
        );

        if (originalOnBeforeCompile) {
          originalOnBeforeCompile(shader, renderer);
        }
      };
      patchable.customProgramCacheKey = () => {
        const baseKey = originalCustomProgramCacheKey ? originalCustomProgramCacheKey() : '';
        return `${baseKey}|faa-plate-overlay-v1`;
      };

      patchedMaterialsRef.current.add(material);
      patchedStateRef.current.set(material, { uniforms });
      material.needsUpdate = true;
    },
    [overlayEnabled, plateHomography, plateTexture]
  );

  const patchSceneMaterials = useCallback(
    (scene: THREE.Object3D) => {
      scene.traverse((node: THREE.Object3D) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!material) continue;
          patchMaterial(material);
        }
      });
    },
    [patchMaterial]
  );

  const patchLoadedModels = useCallback(() => {
    const renderer = tilesRendererRef.current;
    if (!renderer) return;
    renderer.forEachLoadedModel((scene: THREE.Object3D) => {
      patchSceneMaterials(scene);
    });
    syncPatchedMaterials();
  }, [patchSceneMaterials, syncPatchedMaterials]);

  useEffect(() => {
    patchLoadedModels();
  }, [patchLoadedModels]);

  const handleLoadError = useCallback(
    (event: { error: Error }) => {
      loadErrorCountRef.current += 1;
      // Ignore sporadic network/tile misses; fail over only when repeated quickly.
      if (loadErrorCountRef.current < 16 || fatalErrorReportedRef.current) return;
      fatalErrorReportedRef.current = true;
      onRuntimeError?.('3D tiles failed repeatedly.', event.error);
    },
    [onRuntimeError]
  );
  const handleLoadModel = useCallback(
    (event: { scene: THREE.Object3D }) => {
      patchSceneMaterials(event.scene);
      syncPatchedMaterials();
    },
    [patchSceneMaterials, syncPatchedMaterials]
  );
  const handleTilesLoadEnd = useCallback(() => {
    loadErrorCountRef.current = 0;
    patchLoadedModels();
  }, [patchLoadedModels]);

  if (!apiKey) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">
          Satellite and 3D plate modes require `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
        </div>
      </Html>
    );
  }

  return (
    <>
      <group
        position={[0, airportElevationY, 0]}
        scale={[METERS_TO_NM, METERS_TO_NM * verticalScale, METERS_TO_NM]}
      >
        <group matrixAutoUpdate={false} matrix={ecefToLocal}>
          <TilesRenderer
            ref={tilesRendererRef}
            key={rendererKey}
            url={`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`}
            errorTarget={SATELLITE_TILES_ERROR_TARGET}
            onLoadError={handleLoadError}
            onLoadModel={handleLoadModel}
            onTilesLoadEnd={handleTilesLoadEnd}
          >
            <TilesPlugin
              plugin={GoogleCloudAuthPlugin}
              args={[
                {
                  apiToken: apiKey,
                  autoRefreshToken: true
                }
              ]}
            />
            <TilesPlugin plugin={GLTFExtensionsPlugin} dracoLoader={dracoLoader} />
            <TilesPlugin plugin={TileCompressionPlugin} />
            <TilesPlugin plugin={UpdateOnChangePlugin} />
            <TilesPlugin plugin={TilesFadePlugin} />
            <TilesAttributionOverlay />
          </TilesRenderer>
        </group>
      </group>
      {plateOverlay && plateLoading && (
        <Html center position={[0, 3, 0]}>
          <div className="loading-3d">Loading FAA plate texture...</div>
        </Html>
      )}
      {plateOverlay && plateError && !plateLoading && (
        <Html center position={[0, 3, 0]}>
          <div className="loading-3d">{plateError}</div>
        </Html>
      )}
    </>
  );
});
