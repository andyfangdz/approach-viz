import type { EchoTopSurfaceCell, NexradVolumePayload } from './nexrad-types';
import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';

export interface PhaseDebugHeaderValues {
  phaseMode: string | null;
  phaseDetail: string | null;
  zdrAgeSeconds: number | null;
  rhohvAgeSeconds: number | null;
  zdrTimestamp: string | null;
  rhohvTimestamp: string | null;
  precipFlagTimestamp: string | null;
  freezingLevelTimestamp: string | null;
}

export interface NexradPrepareSabBuffers {
  control: SharedArrayBuffer;
  validIndices: SharedArrayBuffer;
  yBase: SharedArrayBuffer;
  heightBase: SharedArrayBuffer;
  correctedBottomFeet: SharedArrayBuffer;
  correctedTopFeet: SharedArrayBuffer;
  effectivePhaseCode: SharedArrayBuffer;
  declutterIndices: SharedArrayBuffer;
  crossSectionGrid: SharedArrayBuffer;
  crossSectionPhaseGrid: SharedArrayBuffer;
  crossSectionTopEnvelopeFeet: SharedArrayBuffer;
}

export interface NexradInitSabRequestMessage {
  type: 'init-sab';
  channelId: number;
  buffers: NexradPrepareSabBuffers;
}

export interface PollAndPrepareRequestMessage {
  type: 'poll-and-prepare';
  requestId: number;
  volumeUrl?: string;
  echoTopUrl?: string;
  includeVolume: boolean;
  includeEchoTop: boolean;
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  includeCrossSection: boolean;
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
  preferSab: true;
  sabChannelId: number;
}

export type NexradWorkerRequestMessage = NexradInitSabRequestMessage | PollAndPrepareRequestMessage;

export interface NexradPrepareSabOverflow {
  voxelCapacity: number;
}

export interface PollAndPrepareTimings {
  volumeFetchMs: number | null;
  volumeDecodeMs: number | null;
  volumePrepareMs: number | null;
  echoTopFetchMs: number | null;
  echoTopDecodeMs: number | null;
  echoTopPrepareMs: number | null;
}

export interface PollAndPrepareEchoTopSummary {
  sourceCellCount: number;
  maxTop18Feet: number | null;
  maxTop30Feet: number | null;
  maxTop50Feet: number | null;
  maxTop60Feet: number | null;
  top18Timestamp: string | null;
  top30Timestamp: string | null;
  top50Timestamp: string | null;
  top60Timestamp: string | null;
  error: string | null;
}

export interface PollAndPrepareResponseMessage {
  type: 'poll-and-prepare-result';
  requestId: number;
  usedSab?: boolean;
  sabOverflow?: NexradPrepareSabOverflow;
  volumePayload?: NexradVolumePayload;
  echoTop18Cells?: EchoTopSurfaceCell[];
  echoTop30Cells?: EchoTopSurfaceCell[];
  echoTop50Cells?: EchoTopSurfaceCell[];
  echoTopSummary?: PollAndPrepareEchoTopSummary | null;
  timings?: PollAndPrepareTimings;
  error?: string;
}

export type NexradWorkerResponseMessage = PollAndPrepareResponseMessage;
