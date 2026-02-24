type SharedArrayBufferConstructorWithOptions = {
  new (byteLength: number, options?: { maxByteLength?: number }): SharedArrayBuffer;
};

type GrowableSharedArrayBuffer = SharedArrayBuffer & {
  readonly maxByteLength?: number;
  grow: (newByteLength: number) => void;
};

const sharedArrayBufferConstructor = globalThis.SharedArrayBuffer as unknown as
  | SharedArrayBufferConstructorWithOptions
  | undefined;

function sanitizeByteLength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function createSharedArrayBuffer(
  byteLength: number,
  maxByteLength?: number
): SharedArrayBuffer {
  if (!sharedArrayBufferConstructor) {
    throw new Error('SharedArrayBuffer is not available in this runtime.');
  }
  const safeByteLength = sanitizeByteLength(byteLength);
  const safeMaxByteLength = Math.max(
    safeByteLength,
    sanitizeByteLength(maxByteLength ?? byteLength)
  );
  return new sharedArrayBufferConstructor(safeByteLength, {
    maxByteLength: safeMaxByteLength
  });
}

export function tryGrowSharedArrayBuffer(
  buffer: SharedArrayBuffer,
  nextByteLength: number
): boolean {
  const safeNextByteLength = sanitizeByteLength(nextByteLength);
  if (safeNextByteLength <= buffer.byteLength) {
    return true;
  }
  const growableBuffer = buffer as GrowableSharedArrayBuffer;
  if (
    typeof growableBuffer.maxByteLength === 'number' &&
    safeNextByteLength > growableBuffer.maxByteLength
  ) {
    return false;
  }
  try {
    growableBuffer.grow(safeNextByteLength);
    return true;
  } catch {
    return false;
  }
}
