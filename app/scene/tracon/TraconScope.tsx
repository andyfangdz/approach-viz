import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
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
import {
  centeredLabelBox,
  declutterBoxes,
  symbolBox,
  symbolLabelBox,
  type ScreenBox
} from './label-declutter';

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
const SYMBOL_LABEL_OFFSET_PX = 8;
const SYMBOL_LABEL_SIZING: LabelSizing = {
  mode: 'screen',
  offsetPx: [SYMBOL_LABEL_OFFSET_PX, 0],
  align: 'start'
};
const AREA_LABEL_SIZING: LabelSizing = { mode: 'screen' };

function sceneLabels(
  labels: readonly ScopeMapLabel[],
  style: SceneLabel['style'],
  shown: readonly boolean[] | undefined
): SceneLabel[] {
  const list: SceneLabel[] = [];
  labels.forEach(({ text, position }, index) => {
    if (shown && !shown[index]) return;
    list.push({ text, position, style });
  });
  return list;
}

/** One map's text for decluttering; earlier groups win overlaps. */
interface MapLabelGroup {
  labels: readonly ScopeMapLabel[];
  /** Symbol glyph size for symbol names; area labels are centered and have none. */
  symbolSizePx: number | null;
}

/**
 * Which labels of each group to draw at the current view. A STARS video
 * map is drawn for one range and never overprints its own text; this app
 * draws FAA data at any range, so it thins the text instead: in priority
 * order (navaids, approach fixes, STAR fixes, SUA, MVA), a label that would
 * overlap a map symbol or a label already placed is left off, while every
 * symbol stays. Recomputed only when the view or the groups change.
 */
function useDeclutteredLabels(groups: readonly MapLabelGroup[]) {
  const groupRef = useRef<THREE.Group>(null);
  const [shown, setShown] = useState<readonly (readonly boolean[])[]>([]);
  const last = useRef<{
    view: THREE.Matrix4;
    width: number;
    height: number;
    groups: readonly MapLabelGroup[] | null;
  }>({ view: new THREE.Matrix4(), width: 0, height: 0, groups: null });

  useFrame(({ camera, size }) => {
    const group = groupRef.current;
    if (!group) return;
    const view = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(group.matrixWorld);
    const previous = last.current;
    if (
      previous.groups === groups &&
      previous.width === size.width &&
      previous.height === size.height &&
      previous.view.equals(view)
    ) {
      return;
    }
    last.current = { view, width: size.width, height: size.height, groups };

    const point = new THREE.Vector4();
    const toScreen = (position: readonly [number, number, number]): [number, number] | null => {
      point.set(position[0], position[1], position[2], 1).applyMatrix4(view);
      if (point.w <= 0) return null;
      const x = ((point.x / point.w + 1) / 2) * size.width;
      const y = ((1 - point.y / point.w) / 2) * size.height;
      if (x < -50 || y < -50 || x > size.width + 50 || y > size.height + 50) return null;
      return [x, y];
    };
    const reserved: ScreenBox[] = [];
    const boxes: (ScreenBox | null)[] = [];
    for (const { labels, symbolSizePx } of groups) {
      for (const label of labels) {
        const screen = toScreen(label.position);
        if (!screen) {
          boxes.push(null);
          continue;
        }
        if (symbolSizePx === null) {
          boxes.push(centeredLabelBox(screen[0], screen[1], label.text));
        } else {
          reserved.push(symbolBox(screen[0], screen[1], symbolSizePx));
          boxes.push(symbolLabelBox(screen[0], screen[1], label.text, SYMBOL_LABEL_OFFSET_PX));
        }
      }
    }
    const kept = declutterBoxes(boxes, reserved);
    let offset = 0;
    const next = groups.map(({ labels }) => {
      const flags = kept.slice(offset, offset + labels.length);
      offset += labels.length;
      return flags;
    });
    setShown((current) =>
      current.length === next.length &&
      current.every(
        (flags, i) =>
          flags.length === next[i].length && flags.every((flag, j) => flag === next[i][j])
      )
        ? current
        : next
    );
  });

  return { groupRef, shown };
}

function MapSymbols({
  symbols,
  glyph,
  colors,
  labelStyle,
  labelsShown,
  visible
}: {
  symbols: ScopeMapSymbols;
  glyph: ScreenMarkGlyph;
  colors: readonly string[];
  labelStyle: SceneLabel['style'];
  labelsShown: readonly boolean[] | undefined;
  visible: boolean;
}) {
  const labels = useMemo(
    () => sceneLabels(symbols.labels, labelStyle, labelsShown),
    [symbols, labelStyle, labelsShown]
  );
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
  shown,
  visible
}: {
  labels: readonly ScopeMapLabel[];
  style: SceneLabel['style'];
  shown: readonly boolean[] | undefined;
  visible: boolean;
}) {
  const sceneLabelList = useMemo(() => sceneLabels(labels, style, shown), [labels, style, shown]);
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
 * Class B and C/D boundaries. Rings are centered on the facility. Map text
 * is thinned so labels never overprint (see `useDeclutteredLabels`).
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

  // Declutter order: navaids, approach fixes, STAR fixes, SUA, MVA.
  const labelGroups = useMemo<MapLabelGroup[]>(() => {
    const groups: MapLabelGroup[] = [];
    const none: ScopeMapLabel[] = [];
    const add = (labels: readonly ScopeMapLabel[], on: boolean, symbolSizePx: number | null) =>
      groups.push({ labels: on ? labels : none, symbolSizePx });
    add(videoMap.vors.labels, maps.navaids, VOR_GLYPH.sizePx);
    add(videoMap.ndbs.labels, maps.navaids, NDB_GLYPH.sizePx);
    add(videoMap.approachFixes.labels, maps.fixes, FIX_GLYPH.sizePx);
    add(videoMap.arrivalFixes.labels, maps.arrivals, FIX_GLYPH.sizePx);
    add(videoMap.specialUseLabels, maps.specialUse, null);
    add(videoMap.mvaLabels, maps.mva, null);
    return groups;
  }, [videoMap, maps]);
  const { groupRef, shown } = useDeclutteredLabels(labelGroups);
  const [vorShown, ndbShown, fixShown, arrivalShown, specialUseShown, mvaShown] = shown;

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
    <group ref={groupRef}>
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
        labelsShown={fixShown}
        glyph={FIX_GLYPH}
        colors={MAP_A_COLORS}
        labelStyle={MAP_A_LABEL_STYLE}
        visible={maps.fixes}
      />
      <MapSymbols
        symbols={videoMap.vors}
        labelsShown={vorShown}
        glyph={VOR_GLYPH}
        colors={MAP_A_COLORS}
        labelStyle={MAP_A_LABEL_STYLE}
        visible={maps.navaids}
      />
      <MapSymbols
        symbols={videoMap.ndbs}
        labelsShown={ndbShown}
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
        labelsShown={arrivalShown}
        glyph={FIX_GLYPH}
        colors={MAP_B_COLORS}
        labelStyle={MAP_B_LABEL_STYLE}
        visible={maps.arrivals}
      />
      <MapLines segments={videoMap.mvaSegments} color={SCOPE_COLORS.mapB} visible={maps.mva} />
      <AreaLabels
        labels={videoMap.mvaLabels}
        style={MAP_B_LABEL_STYLE}
        shown={mvaShown}
        visible={maps.mva}
      />
      <MapLines
        segments={videoMap.specialUseSegments}
        color={SCOPE_COLORS.mapB}
        visible={maps.specialUse}
      />
      <AreaLabels
        labels={videoMap.specialUseLabels}
        style={MAP_B_LABEL_STYLE}
        shown={specialUseShown}
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
