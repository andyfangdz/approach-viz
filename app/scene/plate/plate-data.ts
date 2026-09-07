const PLATE_RENDER_SCALE = 4;
const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface GeoControlPoint {
  u: number;
  v: number;
  lat: number;
  lon: number;
}

export interface GeoReferenceMetadata {
  mediaBox: [number, number, number, number];
  bbox: [number, number, number, number];
  controlPoints: GeoControlPoint[];
}

function parseNumberArray(raw: string): number[] {
  const matches = raw.match(/-?\d+(?:\.\d+)?/g) || [];
  return matches.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value));
}

export function solveLinearSystem(equations: number[][]): number[] | null {
  const size = equations.length;
  if (size === 0) return null;
  const matrix = equations.map((row) => row.slice());
  if (!matrix.every((row) => row.length === size + 1)) return null;

  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    for (let candidate = pivot + 1; candidate < size; candidate += 1) {
      if (Math.abs(matrix[candidate][pivot]) > Math.abs(matrix[maxRow][pivot])) {
        maxRow = candidate;
      }
    }

    if (Math.abs(matrix[maxRow][pivot]) < 1e-10) return null;
    if (maxRow !== pivot) {
      [matrix[pivot], matrix[maxRow]] = [matrix[maxRow], matrix[pivot]];
    }

    const pivotValue = matrix[pivot][pivot];
    for (let col = pivot; col <= size; col += 1) {
      matrix[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let col = pivot; col <= size; col += 1) {
        matrix[row][col] -= factor * matrix[pivot][col];
      }
    }
  }

  return matrix.map((row) => row[size]);
}

function solveLinearSystem4(equations: number[][]): [number, number, number, number] | null {
  const solved = solveLinearSystem(equations);
  if (!solved || solved.length !== 4) return null;
  return [solved[0], solved[1], solved[2], solved[3]];
}

export function extractGeoReferenceMetadata(bytes: Uint8Array): GeoReferenceMetadata | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const viewportStart = text.indexOf('/VP[');
  if (viewportStart < 0) return null;

  const viewportSlice = text.slice(viewportStart, Math.min(text.length, viewportStart + 24000));
  const bboxMatch = viewportSlice.match(/\/BBox\s*\[([^\]]+)\]/);
  const gptsMatch = viewportSlice.match(/\/GPTS\s*\[([^\]]+)\]/);
  const lptsMatch = viewportSlice.match(/\/LPTS\s*\[([^\]]+)\]/);
  const mediaBoxMatch = text.match(/\/MediaBox\s*\[([^\]]+)\]/);

  if (!bboxMatch || !gptsMatch || !lptsMatch || !mediaBoxMatch) return null;

  const mediaBoxValues = parseNumberArray(mediaBoxMatch[1]);
  const bboxValues = parseNumberArray(bboxMatch[1]);
  const gptsValues = parseNumberArray(gptsMatch[1]);
  const lptsValues = parseNumberArray(lptsMatch[1]);
  if (
    mediaBoxValues.length < 4 ||
    bboxValues.length < 4 ||
    gptsValues.length < 8 ||
    lptsValues.length < 8
  ) {
    return null;
  }

  const controlPoints: GeoControlPoint[] = [];
  const pointCount = Math.min(Math.floor(gptsValues.length / 2), Math.floor(lptsValues.length / 2));
  for (let i = 0; i < pointCount; i += 1) {
    controlPoints.push({
      u: lptsValues[i * 2],
      v: lptsValues[i * 2 + 1],
      lat: gptsValues[i * 2],
      lon: gptsValues[i * 2 + 1]
    });
  }

  if (controlPoints.length < 4) return null;

  return {
    mediaBox: [mediaBoxValues[0], mediaBoxValues[1], mediaBoxValues[2], mediaBoxValues[3]],
    bbox: [bboxValues[0], bboxValues[1], bboxValues[2], bboxValues[3]],
    controlPoints: controlPoints.slice(0, 4)
  };
}

export function fitBilinearModel(
  points: GeoControlPoint[],
  valueSelector: (point: GeoControlPoint) => number
): [number, number, number, number] | null {
  const equations = points
    .slice(0, 4)
    .map((point) => [1, point.u, point.v, point.u * point.v, valueSelector(point)]);
  return solveLinearSystem4(equations);
}

export function evaluateBilinear(
  coeff: [number, number, number, number],
  u: number,
  v: number
): number {
  return coeff[0] + coeff[1] * u + coeff[2] * v + coeff[3] * u * v;
}

export async function renderPlateCanvas(
  bytes: Uint8Array,
  mediaBox: [number, number, number, number],
  bbox: [number, number, number, number]
): Promise<HTMLCanvasElement> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_SRC) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes
  });
  const pdf = await loadingTask.promise;

  try {
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: PLATE_RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create rendering context');
    }

    await page.render({
      canvasContext: context,
      viewport
    }).promise;

    const mediaWidth = mediaBox[2] - mediaBox[0];
    const mediaHeight = mediaBox[3] - mediaBox[1];
    const scaleX = canvas.width / mediaWidth;
    const scaleY = canvas.height / mediaHeight;

    const cropX = Math.max(0, Math.floor((bbox[0] - mediaBox[0]) * scaleX));
    const cropY = Math.max(0, Math.floor((mediaBox[3] - bbox[3]) * scaleY));
    const cropWidth = Math.max(1, Math.floor((bbox[2] - bbox[0]) * scaleX));
    const cropHeight = Math.max(1, Math.floor((bbox[3] - bbox[1]) * scaleY));

    const safeWidth = Math.max(1, Math.min(cropWidth, canvas.width - cropX));
    const safeHeight = Math.max(1, Math.min(cropHeight, canvas.height - cropY));
    const cropped = document.createElement('canvas');
    cropped.width = safeWidth;
    cropped.height = safeHeight;
    const croppedContext = cropped.getContext('2d');
    if (!croppedContext) {
      throw new Error('Unable to create crop context');
    }

    croppedContext.drawImage(
      canvas,
      cropX,
      cropY,
      safeWidth,
      safeHeight,
      0,
      0,
      safeWidth,
      safeHeight
    );

    return cropped;
  } finally {
    await pdf.destroy();
  }
}
