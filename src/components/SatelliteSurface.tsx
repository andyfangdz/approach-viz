import { Html } from '@react-three/drei';
import { useCallback, useMemo, useRef } from 'react';
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UpdateOnChangePlugin,
} from '3d-tiles-renderer/plugins';
import {
  TilesAttributionOverlay,
  TilesPlugin,
  TilesRenderer,
} from '3d-tiles-renderer/r3f';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';
import { Matrix4, Vector3 } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const METERS_TO_NM = 1 / 1852;
const FEET_TO_METERS = 0.3048;
const FEET_TO_NM = 1 / 6076.12;
const SATELLITE_TILES_ERROR_TARGET = 12;

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');

interface SatelliteSurfaceProps {
  refLat: number;
  refLon: number;
  airportElevationFeet: number;
  geoidSeparationFeet: number;
  verticalScale: number;
  onRuntimeError?: (message: string, error?: Error) => void;
}

function computeEcefToLocalNmFrame(
  latitudeDeg: number,
  longitudeDeg: number,
  heightMeters: number,
): Matrix4 {
  const ecefOrigin = new Geodetic(
    radians(longitudeDeg),
    radians(latitudeDeg),
    heightMeters,
  ).toECEF(new Vector3());
  const enuFrame = Ellipsoid.WGS84.getEastNorthUpFrame(
    ecefOrigin,
    new Matrix4(),
  );
  const ecefToEnu = enuFrame.clone().invert();
  // ENU (x=east,y=north,z=up) -> local scene (x=east,y=up,z=south)
  const enuToLocal = new Matrix4().set(
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    -1,
    0,
    0,
    0,
    0,
    0,
    1,
  );
  return enuToLocal.multiply(ecefToEnu);
}

export function SatelliteSurface({
  refLat,
  refLon,
  airportElevationFeet,
  geoidSeparationFeet,
  verticalScale,
  onRuntimeError,
}: SatelliteSurfaceProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
  const loadErrorCountRef = useRef(0);
  const fatalErrorReportedRef = useRef(false);
  const safeLat = Number.isFinite(refLat) ? refLat : 0;
  const safeLon = Number.isFinite(refLon) ? refLon : 0;
  const safeAirportElevationFeet = Number.isFinite(airportElevationFeet) ? airportElevationFeet : 0;
  const safeGeoidSeparationFeet = Number.isFinite(geoidSeparationFeet) ? geoidSeparationFeet : 0;

  const ecefToLocal = useMemo(
    () =>
      computeEcefToLocalNmFrame(
        safeLat,
        safeLon,
        (safeAirportElevationFeet + safeGeoidSeparationFeet) * FEET_TO_METERS,
      ),
    [safeLat, safeLon, safeAirportElevationFeet, safeGeoidSeparationFeet],
  );
  const airportElevationY = useMemo(
    () => safeAirportElevationFeet * FEET_TO_NM * verticalScale,
    [safeAirportElevationFeet, verticalScale],
  );
  const rendererKey = useMemo(
    () => `${apiKey}:${safeLat.toFixed(5)}:${safeLon.toFixed(5)}`,
    [apiKey, safeLat, safeLon],
  );
  const handleLoadError = useCallback((event: { error: Error }) => {
    loadErrorCountRef.current += 1;
    // Ignore sporadic network/tile misses; fail over only when repeated quickly.
    if (loadErrorCountRef.current < 16 || fatalErrorReportedRef.current) return;
    fatalErrorReportedRef.current = true;
    onRuntimeError?.('Satellite tiles failed repeatedly.', event.error);
  }, [onRuntimeError]);
  const handleTilesLoadEnd = useCallback(() => {
    loadErrorCountRef.current = 0;
  }, []);

  if (!apiKey) {
    return (
      <Html center position={[0, 3, 0]}>
        <div className="loading-3d">Satellite mode requires `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.</div>
      </Html>
    );
  }

  return (
    <group
      position={[0, airportElevationY, 0]}
      scale={[METERS_TO_NM, METERS_TO_NM * verticalScale, METERS_TO_NM]}
    >
      <group matrixAutoUpdate={false} matrix={ecefToLocal}>
        <TilesRenderer
          key={rendererKey}
          url={`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`}
          errorTarget={SATELLITE_TILES_ERROR_TARGET}
          onLoadError={handleLoadError}
          onTilesLoadEnd={handleTilesLoadEnd}
        >
          <TilesPlugin
            plugin={GoogleCloudAuthPlugin}
            args={[{
              apiToken: apiKey,
              autoRefreshToken: true,
            }]}
          />
          <TilesPlugin
            plugin={GLTFExtensionsPlugin}
            dracoLoader={dracoLoader}
          />
          <TilesPlugin plugin={TileCompressionPlugin} />
          <TilesPlugin plugin={UpdateOnChangePlugin} />
          <TilesPlugin plugin={TilesFadePlugin} />
          <TilesAttributionOverlay />
        </TilesRenderer>
      </group>
    </group>
  );
}
