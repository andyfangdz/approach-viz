import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ScopeMapVisibility, ShorelineStatus } from '@/app/app-client/types';
import type { AirspaceFeature, TraconVideoMapData } from '@/lib/types';
import { buildShorelineWithWorker } from '../geometry/scene-geometry-client';
import { SceneLabels, type LabelSizing, type SceneLabel } from '../labels/SceneLabels';
import { scopeMapLabelStyle } from '../labels/label-styles';
import {
  buildRangeRings,
  buildScopeVideoMap,
  type ScopeMapLabel,
  type ScopeMapSymbols
} from './scope-geometry';
import { SCOPE_COLORS } from './scope-colors';
import { ScreenMarks, type ScreenMarkGlyph } from './ScreenMarks';

/** Sit just below the floor plane so traffic symbology draws over the map. */
const MAP_OFFSET_NM = -0.002;
/** Map symbols draw under the traffic marks (history dots start at 950). */
const MAP_SYMBOL_RENDER_ORDER = 900;

const FIX_GLYPH: ScreenMarkGlyph = { kind: 'triangle', sizePx: 9, strokePx: 1.1 };
const VOR_GLYPH: ScreenMarkGlyph = { kind: 'hexagon', sizePx: 13, strokePx: 1.1 };
const NDB_GLYPH: ScreenMarkGlyph = { kind: 'ring', sizePx: 9, strokePx: 1.1 };
const MAP_A_COLORS = [SCOPE_COLORS.mapA] as const;
const MAP_B_COLORS = [SCOPE_COLORS.mapB] as const;
const MAP_A_LABEL_STYLE = scopeMapLabelStyle(SCOPE_COLORS.mapA);
const MAP_B_LABEL_STYLE = scopeMapLabelStyle(SCOPE_COLORS.mapB);
/** Symbol names sit to the right of the symbol. */
const SYMBOL_LABEL_SIZING: LabelSizing = { mode: 'screen', offsetPx: [8, 0], align: 'start' };
const AREA_LABEL_SIZING: LabelSizing = { mode: 'screen' };

function sceneLabels(labels: readonly ScopeMapLabel[], style: SceneLabel['style']): SceneLabel[] {
  return labels.map(({ text, position }) => ({ text, position, style }));
}

function MapSymbols({
  symbols,
  glyph,
  colors,
  labelStyle,
  visible
}: {
  symbols: ScopeMapSymbols;
  glyph: ScreenMarkGlyph;
  colors: readonly string[];
  labelStyle: SceneLabel['style'];
  visible: boolean;
}) {
  const labels = useMemo(() => sceneLabels(symbols.labels, labelStyle), [symbols, labelStyle]);
  if (!visible || symbols.labels.length === 0) return null;
  return (
    <>
      <ScreenMarks
        positions={symbols.positions}
        colors={colors}
        glyph={glyph}
        renderOrder={MAP_SYMBOL_RENDER_ORDER}
      />
      <SceneLabels labels={labels} sizing={SYMBOL_LABEL_SIZING} />
    </>
  );
}

function AreaLabels({
  labels,
  style,
  visible
}: {
  labels: readonly ScopeMapLabel[];
  style: SceneLabel['style'];
  visible: boolean;
}) {
  const sceneLabelList = useMemo(() => sceneLabels(labels, style), [labels, style]);
  if (!visible || labels.length === 0) return null;
  return <SceneLabels labels={sceneLabelList} sizing={AREA_LABEL_SIZING} />;
}

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

function MapLines({
  segments,
  color,
  visible
}: {
  segments: Float32Array;
  color: string;
  visible: boolean;
}) {
  const geometry = useMemo(() => segmentsGeometry(segments), [segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  if (!visible || segments.length === 0) return null;
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={color} toneMapped={false} />
    </lineSegments>
  );
}

/**
 * STARS video maps and range rings for a TRACON facility, flat on the floor
 * plane: sea-level shoreline (traced in the scene-geometry worker), runways
 * of every airport in range, member airports' approach finals and fixes,
 * navaids, STAR routes, the facility MVA chart, special use airspace, and
 * Class B and C/D boundaries. Rings are centered on the facility.
 */
export function TraconScope({
  centerLat,
  centerLon,
  videoMapData,
  airspace,
  floorY,
  ringSpacingNm,
  ringMaxRadiusNm,
  shorelineRadiusNm,
  maps,
  showAirspaceMaps,
  onShorelineStatusChange
}: {
  centerLat: number;
  centerLon: number;
  videoMapData: TraconVideoMapData;
  airspace: AirspaceFeature[];
  floorY: number;
  /** 0 hides the rings. */
  ringSpacingNm: number;
  ringMaxRadiusNm: number;
  shorelineRadiusNm: number;
  maps: ScopeMapVisibility;
  /** The 3D view shows airspace as volumes instead. */
  showAirspaceMaps: boolean;
  onShorelineStatusChange?: (status: ShorelineStatus) => void;
}) {
  const invalidate = useThree((state) => state.invalidate);
  const y = floorY + MAP_OFFSET_NM;
  const videoMap = useMemo(
    () => buildScopeVideoMap(videoMapData, airspace, centerLat, centerLon, y),
    [videoMapData, airspace, centerLat, centerLon, y]
  );
  const rings = useMemo(
    () => buildRangeRings(ringSpacingNm, ringMaxRadiusNm, y),
    [ringSpacingNm, ringMaxRadiusNm, y]
  );

  const shorelineKey = `${centerLat}|${centerLon}|${shorelineRadiusNm}|${y}`;
  const [shoreline, setShoreline] = useState<{ key: string; segments: Float32Array } | null>(null);
  useEffect(() => {
    let cancelled = false;
    onShorelineStatusChange?.('loading');
    buildShorelineWithWorker({
      refLat: centerLat,
      refLon: centerLon,
      radiusNm: shorelineRadiusNm,
      y
    })
      .then((segments) => {
        if (cancelled) return;
        if (!segments) {
          onShorelineStatusChange?.('unavailable');
          return;
        }
        setShoreline({ key: shorelineKey, segments });
        onShorelineStatusChange?.('ready');
        invalidate();
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('TRACON shoreline map failed', error);
        onShorelineStatusChange?.('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [
    centerLat,
    centerLon,
    shorelineRadiusNm,
    y,
    shorelineKey,
    invalidate,
    onShorelineStatusChange
  ]);
  const shorelineSegments = shoreline?.key === shorelineKey ? shoreline.segments : null;

  return (
    <group>
      <MapLines segments={rings} color={SCOPE_COLORS.rangeRing} visible={ringSpacingNm > 0} />
      {shorelineSegments && (
        <MapLines segments={shorelineSegments} color={SCOPE_COLORS.mapA} visible={maps.shoreline} />
      )}
      <MapLines
        segments={videoMap.runwaySegments}
        color={SCOPE_COLORS.mapA}
        visible={maps.runways}
      />
      <MapLines segments={videoMap.finalSegments} color={SCOPE_COLORS.mapA} visible={maps.finals} />
      <MapSymbols
        symbols={videoMap.approachFixes}
        glyph={FIX_GLYPH}
        colors={MAP_A_COLORS}
        labelStyle={MAP_A_LABEL_STYLE}
        visible={maps.fixes}
      />
      <MapSymbols
        symbols={videoMap.vors}
        glyph={VOR_GLYPH}
        colors={MAP_A_COLORS}
        labelStyle={MAP_A_LABEL_STYLE}
        visible={maps.navaids}
      />
      <MapSymbols
        symbols={videoMap.ndbs}
        glyph={NDB_GLYPH}
        colors={MAP_A_COLORS}
        labelStyle={MAP_A_LABEL_STYLE}
        visible={maps.navaids}
      />
      <MapLines
        segments={videoMap.arrivalSegments}
        color={SCOPE_COLORS.mapB}
        visible={maps.arrivals}
      />
      <MapSymbols
        symbols={videoMap.arrivalFixes}
        glyph={FIX_GLYPH}
        colors={MAP_B_COLORS}
        labelStyle={MAP_B_LABEL_STYLE}
        visible={maps.arrivals}
      />
      <MapLines segments={videoMap.mvaSegments} color={SCOPE_COLORS.mapB} visible={maps.mva} />
      <AreaLabels labels={videoMap.mvaLabels} style={MAP_B_LABEL_STYLE} visible={maps.mva} />
      <MapLines
        segments={videoMap.specialUseSegments}
        color={SCOPE_COLORS.mapB}
        visible={maps.specialUse}
      />
      <AreaLabels
        labels={videoMap.specialUseLabels}
        style={MAP_B_LABEL_STYLE}
        visible={maps.specialUse}
      />
      <MapLines
        segments={videoMap.classBSegments}
        color={SCOPE_COLORS.mapB}
        visible={showAirspaceMaps && maps.classB}
      />
      <MapLines
        segments={videoMap.classCDSegments}
        color={SCOPE_COLORS.mapB}
        visible={showAirspaceMaps && maps.classCD}
      />
    </group>
  );
}
