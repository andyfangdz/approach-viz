import {
  extractGeoReferenceMetadata,
  fitBilinearModel,
  evaluateBilinear,
  renderPlateCanvas,
  solveLinearSystem
} from './plate/plate-data';
import { Html } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
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
import type { ChartType } from '@/app/app-client/types';
import { buildChartTexture } from '@/app/scene/ChartMapSurface';
import { latLonToLocal } from './approach-path/coordinates';

const METERS_TO_NM = 1 / 1852;
const FEET_TO_METERS = 0.3048;
const FEET_TO_NM = 1 / 6076.12;
const SEA_LEVEL_Y = 0;
const EARTH_RADIUS_NM = 3440.065;
const SATELLITE_TILES_ERROR_TARGET = 12;
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

const EMPTY_TEXTURE = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
EMPTY_TEXTURE.needsUpdate = true;

interface ChartOverlayConfig {
  chartType: ChartType;
  radiusNm: number;
}

interface SatelliteSurfaceProps {
  refLat: number;
  refLon: number;
  airportElevationFeet: number;
  geoidSeparationFeet: number;
  verticalScale: number;
  flattenBathymetry: boolean;
  plateOverlay: ApproachPlate | null;
  chartOverlay: ChartOverlayConfig | null;
  onRuntimeError?: (message: string, error?: Error) => void;
}

interface PlateOverlayData {
  texture: THREE.CanvasTexture;
  homography: THREE.Matrix3;
}

interface PatchedMaterialUniforms {
  uPlateMap: { value: THREE.Texture };
  uPlateEnabled: { value: number };
  uPlateHomography: { value: THREE.Matrix3 };
  uChartMap: { value: THREE.Texture };
  uChartEnabled: { value: number };
  uChartHomography: { value: THREE.Matrix3 };
  uSeaLevelY: { value: number };
  uFlattenBathymetry: { value: number };
  uEarthRadiusNm: { value: number };
  uVerticalScale: { value: number };
}

interface PatchedMaterialState {
  uniforms: PatchedMaterialUniforms;
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
  flattenBathymetry,
  plateOverlay,
  chartOverlay,
  onRuntimeError
}: SatelliteSurfaceProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
  const gl = useThree((s) => s.gl);
  const maxTextureDim = useMemo(() => {
    const ctx = gl.getContext();
    const maxTextureSize = Number(ctx.getParameter(ctx.MAX_TEXTURE_SIZE));
    if (!Number.isFinite(maxTextureSize) || maxTextureSize < 1) {
      throw new Error('WebGL MAX_TEXTURE_SIZE is not a finite number.');
    }
    return maxTextureSize;
  }, [gl]);
  const tilesRendererRef = useRef<TilesRendererImpl | null>(null);
  const loadErrorCountRef = useRef(0);
  const fatalErrorReportedRef = useRef(false);
  const patchedMaterialsRef = useRef<Set<THREE.Material>>(new Set());
  const patchedStateRef = useRef<WeakMap<THREE.Material, PatchedMaterialState>>(new WeakMap());
  const disposeListenerRef = useRef<WeakMap<THREE.Material, (event: THREE.Event) => void>>(
    new WeakMap()
  );
  const [plateTexture, setPlateTexture] = useState<THREE.CanvasTexture | null>(null);
  const [plateHomography, setPlateHomography] = useState<THREE.Matrix3 | null>(null);
  const [plateLoading, setPlateLoading] = useState(false);
  const [plateError, setPlateError] = useState('');
  const [chartTexture, setChartTexture] = useState<THREE.CanvasTexture | null>(null);
  const [chartHomography, setChartHomography] = useState<THREE.Matrix3 | null>(null);
  const safeLat = Number.isFinite(refLat) ? refLat : 0;
  const safeLon = Number.isFinite(refLon) ? refLon : 0;
  const safeAirportElevationFeet = Number.isFinite(airportElevationFeet) ? airportElevationFeet : 0;
  const safeGeoidSeparationFeet = Number.isFinite(geoidSeparationFeet) ? geoidSeparationFeet : 0;

  const overlayEnabled = Boolean(plateOverlay && plateTexture && plateHomography);
  const chartOverlayEnabled = Boolean(chartOverlay && chartTexture && chartHomography);
  const flattenBathymetryUniformValue = flattenBathymetry ? 1 : 0;

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

  // --- Chart overlay loading ---
  useEffect(() => {
    if (!chartOverlay) {
      setChartHomography(null);
      setChartTexture((previous) => {
        previous?.dispose();
        return null;
      });
      return;
    }
    const { chartType, radiusNm } = chartOverlay;

    setChartHomography(null);
    setChartTexture((previous) => {
      previous?.dispose();
      return null;
    });

    const { promise, cancel } = buildChartTexture(
      safeLat,
      safeLon,
      radiusNm,
      chartType,
      maxTextureDim
    );
    let active = true;

    promise
      .then((data) => {
        if (!active) {
          data.texture.dispose();
          return;
        }
        const { corners } = data;
        const source = [corners.sw, corners.se, corners.ne, corners.nw];
        const target = [
          { u: 0, v: 0 },
          { u: 1, v: 0 },
          { u: 1, v: 1 },
          { u: 0, v: 1 }
        ];
        const homography = solveHomography(source, target);
        if (!homography) {
          data.texture.dispose();
          return;
        }
        setChartTexture(data.texture);
        setChartHomography(homography);
      })
      .catch((error) => {
        if (active) {
          console.warn(
            'Chart overlay texture load failed.',
            error instanceof Error ? error : 'chart overlay load failed'
          );
        }
      });

    return () => {
      active = false;
      cancel();
      setChartHomography(null);
      setChartTexture((previous) => {
        previous?.dispose();
        return null;
      });
    };
  }, [chartOverlay?.chartType, chartOverlay?.radiusNm, safeLat, safeLon, maxTextureDim]);

  useEffect(
    () => () => {
      chartTexture?.dispose();
    },
    [chartTexture]
  );

  useEffect(
    () => () => {
      for (const material of patchedMaterialsRef.current) {
        const disposeListener = disposeListenerRef.current.get(material);
        if (disposeListener) {
          material.removeEventListener('dispose', disposeListener);
        }
      }
      patchedMaterialsRef.current.clear();
      patchedStateRef.current = new WeakMap();
      disposeListenerRef.current = new WeakMap();
      tilesRendererRef.current = null;
    },
    []
  );

  const syncPatchedMaterials = useCallback(() => {
    const textureValue = overlayEnabled && plateTexture ? plateTexture : EMPTY_TEXTURE;
    const enabledValue = overlayEnabled ? 1 : 0;
    const homographyValue = overlayEnabled && plateHomography ? plateHomography : null;
    const chartTextureValue = chartOverlayEnabled && chartTexture ? chartTexture : EMPTY_TEXTURE;
    const chartEnabledValue = chartOverlayEnabled ? 1 : 0;
    const chartHomographyValue = chartOverlayEnabled && chartHomography ? chartHomography : null;

    for (const material of patchedMaterialsRef.current) {
      const state = patchedStateRef.current.get(material);
      if (!state) continue;
      state.uniforms.uPlateMap.value = textureValue;
      state.uniforms.uPlateEnabled.value = enabledValue;
      state.uniforms.uChartMap.value = chartTextureValue;
      state.uniforms.uChartEnabled.value = chartEnabledValue;
      state.uniforms.uFlattenBathymetry.value = flattenBathymetryUniformValue;
      state.uniforms.uEarthRadiusNm.value = EARTH_RADIUS_NM;
      state.uniforms.uVerticalScale.value = verticalScale;
      if (homographyValue) {
        state.uniforms.uPlateHomography.value.copy(homographyValue);
      } else {
        state.uniforms.uPlateHomography.value.identity();
      }
      if (chartHomographyValue) {
        state.uniforms.uChartHomography.value.copy(chartHomographyValue);
      } else {
        state.uniforms.uChartHomography.value.identity();
      }
    }
  }, [
    overlayEnabled,
    plateTexture,
    plateHomography,
    chartOverlayEnabled,
    chartTexture,
    chartHomography,
    flattenBathymetryUniformValue,
    verticalScale
  ]);

  const patchMaterial = useCallback(
    (material: THREE.Material) => {
      if (patchedMaterialsRef.current.has(material)) return;
      const originalOnBeforeCompile = material.onBeforeCompile.bind(material);
      const originalCustomProgramCacheKey = material.customProgramCacheKey.bind(material);
      const uniforms: PatchedMaterialUniforms = {
        uPlateMap: { value: overlayEnabled && plateTexture ? plateTexture : EMPTY_TEXTURE },
        uPlateEnabled: { value: overlayEnabled ? 1 : 0 },
        uPlateHomography: {
          value:
            overlayEnabled && plateHomography
              ? plateHomography.clone()
              : new THREE.Matrix3().identity()
        },
        uChartMap: {
          value: chartOverlayEnabled && chartTexture ? chartTexture : EMPTY_TEXTURE
        },
        uChartEnabled: { value: chartOverlayEnabled ? 1 : 0 },
        uChartHomography: {
          value:
            chartOverlayEnabled && chartHomography
              ? chartHomography.clone()
              : new THREE.Matrix3().identity()
        },
        uSeaLevelY: { value: SEA_LEVEL_Y },
        uFlattenBathymetry: { value: flattenBathymetryUniformValue },
        uEarthRadiusNm: { value: EARTH_RADIUS_NM },
        uVerticalScale: { value: verticalScale }
      };

      material.onBeforeCompile = (shader, renderer) => {
        shader.uniforms.uPlateMap = uniforms.uPlateMap;
        shader.uniforms.uPlateEnabled = uniforms.uPlateEnabled;
        shader.uniforms.uPlateHomography = uniforms.uPlateHomography;
        shader.uniforms.uChartMap = uniforms.uChartMap;
        shader.uniforms.uChartEnabled = uniforms.uChartEnabled;
        shader.uniforms.uChartHomography = uniforms.uChartHomography;
        shader.uniforms.uSeaLevelY = uniforms.uSeaLevelY;
        shader.uniforms.uFlattenBathymetry = uniforms.uFlattenBathymetry;
        shader.uniforms.uEarthRadiusNm = uniforms.uEarthRadiusNm;
        shader.uniforms.uVerticalScale = uniforms.uVerticalScale;

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>
uniform float uSeaLevelY;
uniform float uFlattenBathymetry;
uniform float uEarthRadiusNm;
uniform float uVerticalScale;
varying vec3 vPlateWorldPos;
vec4 seaLevelClampedWorldPosition;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
vec4 seaLevelTransformedPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
seaLevelTransformedPosition = batchingMatrix * seaLevelTransformedPosition;
#endif
#ifdef USE_INSTANCING
seaLevelTransformedPosition = instanceMatrix * seaLevelTransformedPosition;
#endif
seaLevelClampedWorldPosition = modelMatrix * seaLevelTransformedPosition;
if (uFlattenBathymetry > 0.5) {
  float verticalScaleSafe = max(uVerticalScale, 1e-5);
  float unscaledY = seaLevelClampedWorldPosition.y / verticalScaleSafe;
  float distanceNm = length(seaLevelClampedWorldPosition.xz);
  float curvatureDropNm = (distanceNm * distanceNm) / (2.0 * max(uEarthRadiusNm, 1.0));
  float approxMslAltitudeNm = unscaledY + curvatureDropNm;
  approxMslAltitudeNm = max(approxMslAltitudeNm, uSeaLevelY);
  seaLevelClampedWorldPosition.y = (approxMslAltitudeNm - curvatureDropNm) * verticalScaleSafe;
}
mvPosition = viewMatrix * seaLevelClampedWorldPosition;
gl_Position = projectionMatrix * mvPosition;
vPlateWorldPos = seaLevelClampedWorldPosition.xyz;`
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          `#if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
vec4 worldPosition = seaLevelClampedWorldPosition;
#endif`
        );

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uPlateMap;
uniform float uPlateEnabled;
uniform mat3 uPlateHomography;
uniform sampler2D uChartMap;
uniform float uChartEnabled;
uniform mat3 uChartHomography;
varying vec3 vPlateWorldPos;`
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
if (uChartEnabled > 0.5) {
  vec3 chartUvH = uChartHomography * vec3(vPlateWorldPos.x, vPlateWorldPos.z, 1.0);
  if (abs(chartUvH.z) > 1e-5) {
    vec2 chartUv = chartUvH.xy / chartUvH.z;
    if (chartUv.x >= 0.0 && chartUv.x <= 1.0 && chartUv.y >= 0.0 && chartUv.y <= 1.0) {
      vec4 chartTexel = texture2D(uChartMap, chartUv);
      diffuseColor.rgb = chartTexel.rgb;
    }
  }
}
if (uPlateEnabled > 0.5) {
  vec3 plateUvH = uPlateHomography * vec3(vPlateWorldPos.x, vPlateWorldPos.z, 1.0);
  if (abs(plateUvH.z) > 1e-5) {
    vec2 plateUv = plateUvH.xy / plateUvH.z;
    if (plateUv.x >= 0.0 && plateUv.x <= 1.0 && plateUv.y >= 0.0 && plateUv.y <= 1.0) {
      vec4 plateTexel = texture2D(uPlateMap, plateUv);
      diffuseColor.rgb = mix(diffuseColor.rgb, plateTexel.rgb, plateTexel.a);
    }
  }
}`
        );

        if (originalOnBeforeCompile) {
          originalOnBeforeCompile(shader, renderer);
        }
      };
      material.customProgramCacheKey = () => {
        const baseKey = originalCustomProgramCacheKey ? originalCustomProgramCacheKey() : '';
        return `${baseKey}|faa-overlay-v5`;
      };

      patchedMaterialsRef.current.add(material);
      patchedStateRef.current.set(material, { uniforms });
      const handleDispose = () => {
        patchedMaterialsRef.current.delete(material);
        patchedStateRef.current.delete(material);
        const disposeListener = disposeListenerRef.current.get(material);
        if (disposeListener) {
          material.removeEventListener('dispose', disposeListener);
          disposeListenerRef.current.delete(material);
        }
      };
      disposeListenerRef.current.set(material, handleDispose);
      material.addEventListener('dispose', handleDispose);
      material.needsUpdate = true;
    },
    [
      overlayEnabled,
      plateHomography,
      plateTexture,
      chartOverlayEnabled,
      chartHomography,
      chartTexture,
      flattenBathymetryUniformValue,
      verticalScale
    ]
  );

  const patchSceneMaterials = useCallback(
    (scene: THREE.Object3D) => {
      scene.traverse((node: THREE.Object3D) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
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
