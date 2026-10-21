import { useEffect, useRef, useState } from 'react';
import { buildEdgeCompassRose } from '@/app/scene/tracon/scope-geometry';

/**
 * STARS compass rose along the display edges of the north-up 2D scope. It
 * depends only on the display size, so it is plain SVG over the canvas,
 * redrawn on resize rather than per frame. `insetTopPx` keeps it below the
 * display control bar.
 */
export function EdgeCompassRose({ insetTopPx }: { insetTopPx: number }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return () => {};
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const rose = buildEdgeCompassRose(size.width, size.height, insetTopPx);

  return (
    <svg ref={ref} className="stars-compass-rose" aria-hidden="true">
      {rose.ticks.map((tick, index) => (
        <line key={index} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
      ))}
      {rose.labels.map((label) => (
        <text key={label.text} x={label.x} y={label.y}>
          {label.text}
        </text>
      ))}
    </svg>
  );
}
