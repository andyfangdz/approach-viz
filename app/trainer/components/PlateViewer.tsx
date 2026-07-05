'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApproachPlate } from '@/lib/types';

const PDF_WORKER_SRC = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString();
const RENDER_SCALE = 3;

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; width: number; height: number }
  | { status: 'error'; message: string };

/**
 * Mobile-first FAA plate viewer. Renders page 1 of the d-TPP PDF (through the
 * cached `/api/faa-plate` proxy, so it works offline once cached) and supports
 * one-finger pan + two-finger pinch zoom via pointer events, since the global
 * app shell disables native touch gestures.
 */
export function PlateViewer({ plate }: { plate: ApproachPlate | null }) {
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const frameRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const imgRef = useRef<HTMLImageElement | null>(null);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; scale: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    if (!plate) {
      setLoad({ status: 'idle' });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoad({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(`/api/faa-plate?cycle=${plate.cycle}&file=${plate.plateFile}`);
        if (!res.ok) throw new Error(`Plate unavailable (${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (pdfjs.GlobalWorkerOptions.workerSrc !== PDF_WORKER_SRC) {
          pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        }
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        try {
          const page = await pdf.getPage(1);
          const viewport = page.getViewport({ scale: RENDER_SCALE });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas unavailable');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/png')
          );
          if (!blob) throw new Error('Render failed');
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            setLoad({
              status: 'ready',
              url: objectUrl,
              width: canvas.width,
              height: canvas.height
            });
          }
        } finally {
          await pdf.destroy();
        }
      } catch (err) {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to load plate.'
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [plate]);

  const applyTransform = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const { scale, tx, ty } = transformRef.current;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }, []);

  const reset = useCallback(() => {
    transformRef.current = { scale: 1, tx: 0, ty: 0 };
    applyTransform();
  }, [applyTransform]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchRef.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: transformRef.current.scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2
      };
    }
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const prev = pointers.current.get(e.pointerId);
      if (!prev) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.current.size === 2 && pinchRef.current) {
        const [a, b] = [...pointers.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const nextScale = Math.max(
          0.5,
          Math.min(6, pinchRef.current.scale * (dist / pinchRef.current.dist))
        );
        transformRef.current.scale = nextScale;
        applyTransform();
      } else if (pointers.current.size === 1) {
        transformRef.current.tx += e.clientX - prev.x;
        transformRef.current.ty += e.clientY - prev.y;
        applyTransform();
      }
    },
    [applyTransform]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchRef.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      transformRef.current.scale = Math.max(0.5, Math.min(6, transformRef.current.scale * factor));
      applyTransform();
    },
    [applyTransform]
  );

  if (!plate) {
    return (
      <div className="tr-plate-empty">
        No FAA plate is linked to this procedure in the offline database.
      </div>
    );
  }

  return (
    <div className="tr-plate">
      <div
        className="tr-plate-frame"
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={reset}
      >
        {load.status === 'loading' && <div className="tr-plate-note">Rendering plate…</div>}
        {load.status === 'error' && <div className="tr-plate-note">{load.message}</div>}
        {load.status === 'ready' && (
          <img
            ref={(el) => {
              imgRef.current = el;
              applyTransform();
            }}
            className="tr-plate-img"
            src={load.url}
            alt={`FAA plate ${plate.plateFile}`}
            draggable={false}
          />
        )}
      </div>
      <button type="button" className="tr-btn tr-btn-ghost tr-plate-reset" onClick={reset}>
        Reset view
      </button>
    </div>
  );
}
