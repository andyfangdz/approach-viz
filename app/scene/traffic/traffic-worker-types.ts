export interface SceneAirport {
  lat: number;
  lon: number;
  elevation: number;
}

export interface LiveTrafficAircraft {
  hex: string;
  flight: string | null;
  lat: number;
  lon: number;
  isOnGround?: boolean;
  altitudeFeet: number | null;
  groundSpeedKt: number | null;
  trackDeg: number | null;
  lastSeenSeconds: number | null;
}

export interface LiveTrafficHistoryPoint {
  lat: number;
  lon: number;
  altitudeFeet: number;
  timestampMs: number;
}

export interface TrafficSabBuffers {
  control: SharedArrayBuffer;
  markerPositions: SharedArrayBuffer;
  headingDeg: SharedArrayBuffer;
  flags: SharedArrayBuffer;
  trailOffsets: SharedArrayBuffer;
  trailCounts: SharedArrayBuffer;
  hexOffsets: SharedArrayBuffer;
  hexLengths: SharedArrayBuffer;
  callsignOffsets: SharedArrayBuffer;
  callsignLengths: SharedArrayBuffer;
  points: SharedArrayBuffer;
  strings: SharedArrayBuffer;
}

interface TrafficBaseRequest {
  requestId: number;
  nowMs: number;
  historyMinutes: number;
  hideGroundTargets: boolean;
  showDepartedTrafficTrails: boolean;
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation: boolean;
  sceneAirports: SceneAirport[];
  preferSab: true;
  sabChannelId: number;
}

export interface TrafficInitSabRequest {
  type: 'init-sab';
  channelId: number;
  buffers: TrafficSabBuffers;
}

export interface TrafficResetRequest extends TrafficBaseRequest {
  type: 'reset';
}

export interface TrafficIngestRequest extends TrafficBaseRequest {
  type: 'ingest';
  aircraftList: LiveTrafficAircraft[];
  historyByHex?: Record<string, LiveTrafficHistoryPoint[]>;
}

export interface TrafficBinaryIngestRequest extends TrafficBaseRequest {
  type: 'ingest-binary';
  payloadBuffer: ArrayBuffer;
  historyPayloadBuffer?: ArrayBuffer;
}

export interface TrafficRuntimeIngestRequest extends TrafficBaseRequest {
  type: 'ingest-runtime';
  primaryUrl: string;
  followupUrl?: string;
}

export interface TrafficRecomputeRequest extends TrafficBaseRequest {
  type: 'recompute';
}

export interface TrafficErrorPruneRequest extends TrafficBaseRequest {
  type: 'prune-error';
}

export type TrafficWorkerRequestMessage =
  | TrafficInitSabRequest
  | TrafficResetRequest
  | TrafficIngestRequest
  | TrafficBinaryIngestRequest
  | TrafficRuntimeIngestRequest
  | TrafficRecomputeRequest
  | TrafficErrorPruneRequest;

export interface TrafficSabOverflow {
  trackCapacity: number;
  pointCapacity: number;
  stringCapacity: number;
}

export interface TrafficWorkerResponseMessage {
  type: 'result';
  requestId: number;
  trackCount?: number;
  historyPointCount?: number;
  renderHash?: number;
  operation?: TrafficWorkerRequestMessage['type'];
  workerProcessingMs?: number;
  usedSab?: boolean;
  sabOverflow?: TrafficSabOverflow;
  trackedHexes?: string[];
  returnedHistoryHexes?: string[];
  feedTransport?: 'binary' | 'json';
  fetchMs?: number;
  parseMs?: number;
  error?: string;
}
