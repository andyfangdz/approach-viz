import { applyPhaseDebugValues, decodeEchoTopPayload, decodePayload } from './nexrad-decode';
import type { NexradVolumePayload } from './nexrad-types';
import type {
  DecodeEchoTopRequestMessage,
  DecodeVolumeRequestMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage
} from './nexrad-worker-types';

type WorkerEndpoint = {
  postMessage: (message: NexradWorkerResponseMessage, transfer?: Transferable[]) => void;
};

function volumeTransferables(payload: NexradVolumePayload): Transferable[] {
  return [
    payload.xNm.buffer,
    payload.zNm.buffer,
    payload.bottomFeet.buffer,
    payload.topFeet.buffer,
    payload.dbz.buffer,
    payload.footprintXNm.buffer,
    payload.footprintYNm.buffer,
    payload.phaseCode.buffer,
    payload.surfacePhaseCode.buffer
  ];
}

function handleDecodeVolume(endpoint: WorkerEndpoint, message: DecodeVolumeRequestMessage): void {
  try {
    const decoded = decodePayload(message.buffer);
    const payload = applyPhaseDebugValues(decoded, message.phaseDebug);
    endpoint.postMessage(
      {
        type: 'decode-volume-result',
        requestId: message.requestId,
        payload
      },
      volumeTransferables(payload)
    );
  } catch (error) {
    endpoint.postMessage({
      type: 'decode-volume-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to decode MRMS payload.'
    });
  }
}

function handleDecodeEchoTop(endpoint: WorkerEndpoint, message: DecodeEchoTopRequestMessage): void {
  try {
    const payload = decodeEchoTopPayload(message.buffer);
    endpoint.postMessage({
      type: 'decode-echo-top-result',
      requestId: message.requestId,
      payload
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'decode-echo-top-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to decode MRMS echo-top payload.'
    });
  }
}

function handleMessage(endpoint: WorkerEndpoint, message: NexradWorkerRequestMessage): void {
  if (message.type === 'decode-volume') {
    handleDecodeVolume(endpoint, message);
    return;
  }
  handleDecodeEchoTop(endpoint, message);
}

const scope = self as unknown as {
  postMessage: WorkerEndpoint['postMessage'];
  onmessage: ((event: MessageEvent<NexradWorkerRequestMessage>) => void) | null;
  onconnect?: ((event: MessageEvent) => void) | null;
};

scope.onmessage = (event) => {
  handleMessage(
    {
      postMessage: (message, transfer) => scope.postMessage(message, transfer ?? [])
    },
    event.data
  );
};

if (typeof scope.onconnect !== 'undefined') {
  scope.onconnect = (event: MessageEvent) => {
    const port = event.ports[0];
    if (!port) return;
    port.onmessage = (portEvent: MessageEvent<NexradWorkerRequestMessage>) => {
      handleMessage(
        {
          postMessage: (message, transfer) => port.postMessage(message, transfer ?? [])
        },
        portEvent.data
      );
    };
    port.start();
  };
}

export {};
