import type { EchoTopPayload, NexradVolumePayload } from './nexrad-types';

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

export interface DecodeVolumeRequestMessage {
  type: 'decode-volume';
  requestId: number;
  buffer: ArrayBuffer;
  phaseDebug: PhaseDebugHeaderValues;
}

export interface DecodeEchoTopRequestMessage {
  type: 'decode-echo-top';
  requestId: number;
  buffer: ArrayBuffer;
}

export type NexradWorkerRequestMessage = DecodeVolumeRequestMessage | DecodeEchoTopRequestMessage;

export interface DecodeVolumeResponseMessage {
  type: 'decode-volume-result';
  requestId: number;
  payload?: NexradVolumePayload;
  error?: string;
}

export interface DecodeEchoTopResponseMessage {
  type: 'decode-echo-top-result';
  requestId: number;
  payload?: EchoTopPayload;
  error?: string;
}

export type NexradWorkerResponseMessage =
  | DecodeVolumeResponseMessage
  | DecodeEchoTopResponseMessage;
