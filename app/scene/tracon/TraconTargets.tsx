import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { TrafficRenderBuffers } from '../traffic/traffic-worker-client';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import {
  DATA_BLOCK_LABEL_STYLE,
  POSITION_SYMBOL_LABEL_STYLE,
  SHORT_DATA_BLOCK_LABEL_STYLE
} from '../labels/label-styles';
import { ScreenMarks, type ScreenMarkGlyph } from './ScreenMarks';
import { SCOPE_COLORS, SCOPE_HISTORY_SHADES } from './scope-colors';
import { dataBlockKind, shortDataBlockLine, type AltitudeFilter } from './data-block';
import {
  DATA_BLOCK_LINE_OFFSETS_PX,
  dataBlockTextAnchor,
  LEADER_DIRECTIONS,
  placeDataBlocks
} from './label-declutter';

/** Fused-track target symbol: a filled blue disc under the position symbol. */
const TARGET_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 11 };
const HISTORY_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 6 };
/** Leader line glyph per STARS leader direction. */
const LEADER_GLYPHS: ScreenMarkGlyph[] = LEADER_DIRECTIONS.map(({ fromPx, toPx }) => ({
  kind: 'leader',
  sizePx: 1.25,
  fromPx,
  toPx
}));
const TARGET_COLORS = [SCOPE_COLORS.target] as const;
const LEADER_COLORS = [SCOPE_COLORS.dataBlock] as const;
const POSITION_SYMBOL = '*';
const POSITION_SYMBOL_SIZING = { mode: 'screen', offsetPx: [0, -1] } as const;
/** Each data block line carries its own placement from its leader direction. */
const DATA_BLOCK_SIZING = { mode: 'screen' } as const;
/** A click within this many CSS px of a target selects it. */
const PICK_RADIUS_PX = 12;
/** Pointer travel beyond this is a pan, not a click. */
const CLICK_SLOP_PX = 5;

const HISTORY_RENDER_ORDER = 950;
const TARGET_RENDER_ORDER = 955;
const LEADER_RENDER_ORDER = 960;

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry | null {
  if (segments.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

/**
 * Index of the target nearest `(px, py)` (CSS px in the canvas) within
 * `PICK_RADIUS_PX`, or -1.
 */
function pickTarget(
  positions: Float32Array,
  matrixWorld: THREE.Matrix4,
  camera: THREE.Camera,
  width: number,
  height: number,
  px: number,
  py: number
): number {
  const point = new THREE.Vector3();
  let best = -1;
  let bestDistanceSq = PICK_RADIUS_PX * PICK_RADIUS_PX;
  for (let i = 0; i < positions.length / 3; i += 1) {
    point
      .set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      .applyMatrix4(matrixWorld)
      .project(camera);
    if (point.z < -1 || point.z > 1) continue;
    const dx = ((point.x + 1) / 2) * width - px;
    const dy = ((1 - point.y) / 2) * height - py;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = i;
    }
  }
  return best;
}

interface DataBlock {
  hex: string;
  position: readonly [number, number, number];
  /** One line (partial or limited) or two (full). */
  lines: readonly string[];
}

/**
 * Leader direction per data block at the current view, recomputed when the
 * view or the blocks change. Each block keeps its last direction while that
 * stays clear (see `placeDataBlocks`).
 */
function useLeaderDirections(
  blocks: readonly DataBlock[],
  groupRef: RefObject<THREE.Group | null>
): readonly number[] {
  const [directions, setDirections] = useState<readonly number[]>([]);
  const previousByHex = useRef(new Map<string, number>());
  const last = useRef<{
    view: THREE.Matrix4;
    width: number;
    height: number;
    blocks: readonly DataBlock[] | null;
  }>({ view: new THREE.Matrix4(), width: 0, height: 0, blocks: null });

  useFrame(({ camera, size }) => {
    const group = groupRef.current;
    if (!group) return;
    const view = new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      .multiply(group.matrixWorld);
    const previous = last.current;
    if (
      previous.blocks === blocks &&
      previous.width === size.width &&
      previous.height === size.height &&
      previous.view.equals(view)
    ) {
      return;
    }
    last.current = { view, width: size.width, height: size.height, blocks };

    const point = new THREE.Vector4();
    const placed = placeDataBlocks(
      blocks.map(({ hex, position, lines }) => {
        point.set(position[0], position[1], position[2], 1).applyMatrix4(view);
        const onScreen = point.w > 0;
        return {
          screen: onScreen
            ? ([
                ((point.x / point.w + 1) / 2) * size.width,
                ((1 - point.y / point.w) / 2) * size.height
              ] as const)
            : null,
          chars: Math.max(...lines.map((line) => line.length)),
          lines: lines.length === 2 ? 2 : 1,
          previous: previousByHex.current.get(hex) ?? null
        };
      })
    );
    const remembered = new Map<string, number>();
    blocks.forEach(({ hex }, index) => remembered.set(hex, placed[index]));
    previousByHex.current = remembered;
    setDirections((current) =>
      current.length === placed.length && current.every((value, i) => value === placed[i])
        ? current
        : placed
    );
  });

  return directions;
}

/**
 * STARS presentation of the live traffic the worker prepared, for fused
 * (ADS-B) tracks: blue history dots that darken with age, white predicted
 * track lines, the blue target symbol with its position symbol, and a data
 * block on a leader line. In 3D also altitude stalks to the floor plane.
 *
 * The feed has no track ownership, so no track is owned here: as on a STARS
 * position that owns none of the traffic, associated tracks show a one-line
 * partial data block (altitude and ground speed), unassociated ones a
 * limited data block (altitude), and tracks above the altitude filter only
 * the target. Clicking a target toggles its full data block (callsign line),
 * as clicking a partial data block does in STARS. Leader directions are
 * picked per view so blocks do not overprint each other or other targets,
 * the way controllers offset them by hand.
 */
export function TraconTargets({
  renderBuffers,
  showAltitudeStalks,
  altitudeFilterHighFeet
}: {
  renderBuffers: TrafficRenderBuffers;
  showAltitudeStalks: boolean;
  altitudeFilterHighFeet: number;
}) {
  const predictedTrackGeometry = useMemo(
    () => segmentsGeometry(renderBuffers.predictedTrackSegments),
    [renderBuffers]
  );
  const stalkGeometry = useMemo(
    () => segmentsGeometry(renderBuffers.altitudeStalkSegments),
    [renderBuffers]
  );
  useEffect(() => () => predictedTrackGeometry?.dispose(), [predictedTrackGeometry]);
  useEffect(() => () => stalkGeometry?.dispose(), [stalkGeometry]);

  const [fullDataBlockHexes, setFullDataBlockHexes] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const groupRef = useRef<THREE.Group>(null);
  const camera = useThree((state) => state.camera);
  const canvas = useThree((state) => state.gl.domElement);
  const targetPositionsRef = useRef(renderBuffers.targetPositions);
  targetPositionsRef.current = renderBuffers.targetPositions;
  const targetHexesRef = useRef(renderBuffers.targetHexes);
  targetHexesRef.current = renderBuffers.targetHexes;

  useEffect(() => {
    let down: { x: number; y: number; id: number } | null = null;
    const handleDown = (event: PointerEvent) => {
      down =
        event.button === 0 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    };
    const handleUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      const group = groupRef.current;
      if (!start || !group || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;
      const rect = canvas.getBoundingClientRect();
      const index = pickTarget(
        targetPositionsRef.current,
        group.matrixWorld,
        camera,
        rect.width,
        rect.height,
        event.clientX - rect.left,
        event.clientY - rect.top
      );
      const hex = index >= 0 ? targetHexesRef.current[index] : undefined;
      if (!hex) return;
      setFullDataBlockHexes((current) => {
        const next = new Set(current);
        if (!next.delete(hex)) next.add(hex);
        return next;
      });
    };
    canvas.addEventListener('pointerdown', handleDown);
    canvas.addEventListener('pointerup', handleUp);
    return () => {
      canvas.removeEventListener('pointerdown', handleDown);
      canvas.removeEventListener('pointerup', handleUp);
    };
  }, [camera, canvas]);

  const { symbols, blocks } = useMemo(() => {
    const filter: AltitudeFilter = { lowFeet: null, highFeet: altitudeFilterHighFeet };
    const symbolLabels: SceneLabel[] = [];
    const fullBlocks: DataBlock[] = [];
    const shortBlocks: DataBlock[] = [];
    const { targetPositions, targetHexes, targetAltitudeFeet, targetAssociated } = renderBuffers;
    for (let i = 0; i < targetHexes.length; i += 1) {
      const position = [
        targetPositions[i * 3],
        targetPositions[i * 3 + 1],
        targetPositions[i * 3 + 2]
      ] as const;
      symbolLabels.push({ text: POSITION_SYMBOL, position, style: POSITION_SYMBOL_LABEL_STYLE });
      const kind = dataBlockKind(
        targetAssociated[i] === 1,
        targetAltitudeFeet[i],
        fullDataBlockHexes.has(targetHexes[i]),
        filter
      );
      if (kind === 'none') continue;
      const fields = renderBuffers.dataBlockFields[i];
      if (kind === 'full') {
        const lines = [renderBuffers.dataBlockIdents[i], fields];
        fullBlocks.push({ hex: targetHexes[i], position, lines });
      } else {
        const lines = [shortDataBlockLine(fields, kind)];
        shortBlocks.push({ hex: targetHexes[i], position, lines });
      }
    }
    // Selected (full) blocks claim their places first.
    return { symbols: symbolLabels, blocks: [...fullBlocks, ...shortBlocks] };
  }, [renderBuffers, fullDataBlockHexes, altitudeFilterHighFeet]);

  const directions = useLeaderDirections(blocks, groupRef);

  const placedBlocks = useMemo(() => {
    const lineLabels: SceneLabel[] = [];
    const leaders = LEADER_DIRECTIONS.map((): number[] => []);
    blocks.forEach(({ position, lines }, index) => {
      const direction = directions.length === blocks.length ? directions[index] : 0;
      leaders[direction].push(...position);
      const anchor = dataBlockTextAnchor(direction);
      const offsets =
        lines.length === 2 ? DATA_BLOCK_LINE_OFFSETS_PX.double : DATA_BLOCK_LINE_OFFSETS_PX.single;
      const style = lines.length === 2 ? DATA_BLOCK_LABEL_STYLE : SHORT_DATA_BLOCK_LABEL_STYLE;
      lines.forEach((text, line) => {
        lineLabels.push({
          text,
          position,
          style,
          placement: {
            offsetPx: [anchor.x, anchor.y + offsets[line]],
            align: anchor.side > 0 ? 'start' : 'end'
          }
        });
      });
    });
    return { lineLabels, leaders: leaders.map((list) => new Float32Array(list)) };
  }, [blocks, directions]);

  return (
    <group ref={groupRef}>
      {showAltitudeStalks && stalkGeometry && (
        <lineSegments geometry={stalkGeometry} frustumCulled={false} renderOrder={940}>
          <lineBasicMaterial
            color={SCOPE_COLORS.altitudeStalk}
            transparent
            opacity={0.28}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      {predictedTrackGeometry && (
        <lineSegments geometry={predictedTrackGeometry} frustumCulled={false} renderOrder={945}>
          <lineBasicMaterial
            color={SCOPE_COLORS.predictedTrack}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      <ScreenMarks
        positions={renderBuffers.historyDots}
        stride={4}
        colors={SCOPE_HISTORY_SHADES}
        glyph={HISTORY_GLYPH}
        renderOrder={HISTORY_RENDER_ORDER}
      />
      <ScreenMarks
        positions={renderBuffers.targetPositions}
        colors={TARGET_COLORS}
        glyph={TARGET_GLYPH}
        renderOrder={TARGET_RENDER_ORDER}
      />
      {placedBlocks.leaders.map((positions, direction) => (
        <ScreenMarks
          key={LEADER_DIRECTIONS[direction].keypad}
          positions={positions}
          colors={LEADER_COLORS}
          glyph={LEADER_GLYPHS[direction]}
          renderOrder={LEADER_RENDER_ORDER}
        />
      ))}
      <SceneLabels labels={symbols} sizing={POSITION_SYMBOL_SIZING} />
      <SceneLabels labels={placedBlocks.lineLabels} sizing={DATA_BLOCK_SIZING} />
    </group>
  );
}
