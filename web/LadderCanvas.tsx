import { useLayoutEffect, useRef } from 'react';
import { paintLadder, paletteFrom, type PaintFrame } from './ladderPaint';

/** The ladder's visuals on one canvas behind the (now empty) DOM rows, which keep every click. Sharp on
 * high-DPI screens; repainted after every render (the panel re-renders on market data). */
export function LadderCanvas({ frame }: { frame: PaintFrame }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || frame.width <= 0 || frame.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(frame.width * dpr);
    const h = Math.round(frame.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      c.style.width = `${frame.width}px`;
      c.style.height = `${frame.height}px`;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintLadder(ctx, frame, paletteFrom(document.documentElement));
  });
  return <canvas ref={ref} className="lcanvas" aria-hidden="true" />;
}
