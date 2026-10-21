import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import {
  TRAFFIC_FLAG_IS_ON_GROUND,
  type TrafficRenderBuffers
} from '../traffic/traffic-worker-client';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import { DATA_BLOCK_LABEL_STYLE, GROUND_DATA_BLOCK_LABEL_STYLE } from '../labels/label-styles';
import { ScreenMarks, type ScreenMarkGlyph } from './ScreenMarks';
import { SCOPE_COLORS } from './scope-colors';

const TARGET_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 8 };
const GROUND_TARGET_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 6 };
const HISTORY_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 5 };
/** Leader line toward the data block, which sits up and to the right. */
const LEADER_GLYPH: ScreenMarkGlyph = {
  kind: 'leader',
  sizePx: 1.25,
  fromPx: [5, 5],
  toPx: [15, 15]
};
const IDENT_SIZING = { mode: 'screen', offsetPx: [18, 21], align: 'start' } as const;
const FIELDS_SIZING = { mode: 'screen', offsetPx: [18, 8], align: 'start' } as const;

const TARGET_RENDER_ORDER = 960;
const HISTORY_RENDER_ORDER = 950;
const LEADER_RENDER_ORDER = 955;

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry | null {
  if (segments.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

/**
 * TRACON presentation of the live traffic the worker prepared: target
 * symbols, fading history dots, one-minute predicted track lines, leader
 * lines, and two-line data blocks; in 3D also altitude stalks to the field
 * elevation plane.
 */
export function TraconTargets({
  renderBuffers,
  hideGroundDataBlocks,
  showAltitudeStalks
}: {
  renderBuffers: TrafficRenderBuffers;
  hideGroundDataBlocks: boolean;
  showAltitudeStalks: boolean;
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

  const { identLabels, fieldLabels } = useMemo(() => {
    const idents: SceneLabel[] = [];
    const fields: SceneLabel[] = [];
    const { activeTrackIndices, markerPositions, flags } = renderBuffers;
    activeTrackIndices.forEach((trackIndex, activeIndex) => {
      const isOnGround = (flags[trackIndex] & TRAFFIC_FLAG_IS_ON_GROUND) !== 0;
      if (isOnGround && hideGroundDataBlocks) return;
      const style = isOnGround ? GROUND_DATA_BLOCK_LABEL_STYLE : DATA_BLOCK_LABEL_STYLE;
      const position = [
        markerPositions[trackIndex * 3],
        markerPositions[trackIndex * 3 + 1],
        markerPositions[trackIndex * 3 + 2]
      ] as const;
      idents.push({ text: renderBuffers.dataBlockIdents[activeIndex], position, style });
      fields.push({ text: renderBuffers.dataBlockFields[activeIndex], position, style });
    });
    return { identLabels: idents, fieldLabels: fields };
  }, [renderBuffers, hideGroundDataBlocks]);

  return (
    <group>
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
            transparent
            opacity={0.7}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      <ScreenMarks
        positions={renderBuffers.historyDots}
        stride={4}
        color={SCOPE_COLORS.history}
        glyph={HISTORY_GLYPH}
        renderOrder={HISTORY_RENDER_ORDER}
      />
      <ScreenMarks
        positions={renderBuffers.airborneTargetPositions}
        color={SCOPE_COLORS.dataBlock}
        glyph={LEADER_GLYPH}
        renderOrder={LEADER_RENDER_ORDER}
      />
      {!hideGroundDataBlocks && (
        <ScreenMarks
          positions={renderBuffers.groundTargetPositions}
          color={SCOPE_COLORS.dataBlock}
          opacity={0.6}
          glyph={LEADER_GLYPH}
          renderOrder={LEADER_RENDER_ORDER}
        />
      )}
      <ScreenMarks
        positions={renderBuffers.groundTargetPositions}
        color={SCOPE_COLORS.groundTarget}
        glyph={GROUND_TARGET_GLYPH}
        renderOrder={TARGET_RENDER_ORDER}
      />
      <ScreenMarks
        positions={renderBuffers.airborneTargetPositions}
        color={SCOPE_COLORS.target}
        glyph={TARGET_GLYPH}
        renderOrder={TARGET_RENDER_ORDER}
      />
      <SceneLabels labels={identLabels} sizing={IDENT_SIZING} />
      <SceneLabels labels={fieldLabels} sizing={FIELDS_SIZING} />
    </group>
  );
}
