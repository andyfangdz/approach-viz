import { applyPhaseDebugValues, decodeEchoTopPayload, decodePayload } from './nexrad-decode';
import {
  buildCrossSectionData,
  prepareEchoTopSurfaces,
  prepareVolumeData
} from './nexrad-preprocess';
import type {
  CrossSectionData,
  NexradPreparedVolumeData,
  NexradVolumePayload
} from './nexrad-types';
import type {
  DecodeEchoTopRequestMessage,
  DecodeVolumeRequestMessage,
  NexradWorkerRequestMessage,
  NexradWorkerResponseMessage,
  PrepareEchoTopRequestMessage,
  PrepareVolumeRequestMessage
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

function preparedVolumeTransferables(payload: NexradPreparedVolumeData): Transferable[] {
  return [
    payload.validIndices.buffer,
    payload.yBase.buffer,
    payload.heightBase.buffer,
    payload.correctedBottomFeet.buffer,
    payload.correctedTopFeet.buffer,
    payload.effectivePhaseCode.buffer,
    payload.declutterIndices.buffer
  ];
}

function crossSectionTransferables(data: CrossSectionData | null | undefined): Transferable[] {
  if (!data) return [];
  return [data.grid.buffer, data.phaseGrid.buffer, data.topEnvelopeFeet.buffer];
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

function handlePrepareVolume(endpoint: WorkerEndpoint, message: PrepareVolumeRequestMessage): void {
  try {
    const payload = prepareVolumeData({
      payload: message.payload,
      minDbz: message.minDbz,
      phaseMode: message.phaseMode,
      declutterMode: message.declutterMode,
      applyEarthCurvatureCompensation: message.applyEarthCurvatureCompensation,
      refLat: message.refLat
    });
    const crossSectionData = message.includeCrossSection
      ? buildCrossSectionData({
          payload: message.payload,
          volumeData: payload,
          sliceAxis: message.sliceAxis,
          slicePerpAxis: message.slicePerpAxis,
          normalizedCrossSectionRange: message.normalizedCrossSectionRange,
          crossSectionHalfWidthNm: message.crossSectionHalfWidthNm
        })
      : null;
    endpoint.postMessage(
      {
        type: 'prepare-volume-result',
        requestId: message.requestId,
        payload,
        crossSectionData
      },
      [...preparedVolumeTransferables(payload), ...crossSectionTransferables(crossSectionData)]
    );
  } catch (error) {
    endpoint.postMessage({
      type: 'prepare-volume-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to prepare MRMS volume data.'
    });
  }
}

function handlePrepareEchoTop(
  endpoint: WorkerEndpoint,
  message: PrepareEchoTopRequestMessage
): void {
  try {
    endpoint.postMessage({
      type: 'prepare-echo-top-result',
      requestId: message.requestId,
      ...prepareEchoTopSurfaces({
        payload: message.payload,
        applyEarthCurvatureCompensation: message.applyEarthCurvatureCompensation,
        refLat: message.refLat
      })
    });
  } catch (error) {
    endpoint.postMessage({
      type: 'prepare-echo-top-result',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Failed to prepare MRMS echo-top surfaces.'
    });
  }
}

function handleMessage(endpoint: WorkerEndpoint, message: NexradWorkerRequestMessage): void {
  if (message.type === 'decode-volume') {
    handleDecodeVolume(endpoint, message);
    return;
  }
  if (message.type === 'decode-echo-top') {
    handleDecodeEchoTop(endpoint, message);
    return;
  }
  if (message.type === 'prepare-volume') {
    handlePrepareVolume(endpoint, message);
    return;
  }
  handlePrepareEchoTop(endpoint, message);
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
