import { useEffect, useMemo, useRef, useState } from 'react';
import type { Point, Stroke } from '../db';
import { drawStroke, hitStroke, strokeBounds, type StrokeGroup } from '../ink';
import type { PDFDoc } from '../pdf';
import { useStore } from '../store';

interface Props {
  pdf: PDFDoc;
  pageNum: number;
  width1: number; // page size at scale 1
  height1: number;
  displayWidth: number;
  strokes: Stroke[];
  groups: StrokeGroup[];
}

export default function PageView({ pdf, pageNum, width1, height1, displayWidth, strokes, groups }: Props) {
  const scale = displayWidth / width1;
  const displayHeight = height1 * scale;
  const wrapRef = useRef<HTMLDivElement>(null);
  const pdfCanvas = useRef<HTMLCanvasElement>(null);
  const inkCanvas = useRef<HTMLCanvasElement>(null);
  const liveCanvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [flashBox, setFlashBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const size = useStore((s) => s.size);
  const fingerDraw = useStore((s) => s.fingerDraw);
  const replayT = useStore((s) => s.replayT);
  const playingRecId = useStore((s) => s.playingRecId);
  const flash = useStore((s) => s.flash);
  const showOrder = useStore((s) => s.showOrder);

  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  // Lazy-render pages near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: scale * dpr });
      const c = pdfCanvas.current!;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      await task.promise.catch(() => {});
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNum, scale, dpr, visible]);

  const shown = useMemo(() => {
    if (replayT == null) return strokes;
    return strokes.filter((s) => s.recId === playingRecId && s.t != null && s.t <= replayT);
  }, [strokes, replayT, playingRecId]);

  // Redraw committed ink.
  useEffect(() => {
    const c = inkCanvas.current!;
    c.width = Math.floor(displayWidth * dpr);
    c.height = Math.floor(displayHeight * dpr);
    if (!visible) return;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    for (const s of shown) drawStroke(ctx, s, scale);
  }, [shown, scale, displayWidth, displayHeight, dpr, visible]);

  useEffect(() => {
    const c = liveCanvas.current!;
    c.width = Math.floor(displayWidth * dpr);
    c.height = Math.floor(displayHeight * dpr);
  }, [displayWidth, displayHeight, dpr]);

  // Flash a box around strokes selected from the timeline.
  useEffect(() => {
    if (!flash) return;
    const ids = new Set(flash.ids);
    const mine = strokes.filter((s) => ids.has(s.id));
    if (!mine.length) return;
    const b = mine.map(strokeBounds).reduce((a, c) => ({
      minX: Math.min(a.minX, c.minX), minY: Math.min(a.minY, c.minY),
      maxX: Math.max(a.maxX, c.maxX), maxY: Math.max(a.maxY, c.maxY),
    }));
    setFlashBox({ x: b.minX - 8, y: b.minY - 8, w: b.maxX - b.minX + 16, h: b.maxY - b.minY + 16 });
    const t = setTimeout(() => setFlashBox(null), 1800);
    return () => clearTimeout(t);
  }, [flash, strokes]);

  // Stylus must not scroll the page; fingers still scroll unless finger-drawing is on.
  useEffect(() => {
    const c = liveCanvas.current!;
    const block = (e: TouchEvent) => {
      const stylus = Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
      if (stylus || useStore.getState().fingerDraw) e.preventDefault();
    };
    c.addEventListener('touchstart', block, { passive: false });
    c.addEventListener('touchmove', block, { passive: false });
    return () => {
      c.removeEventListener('touchstart', block);
      c.removeEventListener('touchmove', block);
    };
  }, []);

  const drawing = useRef<{ id: number; points: Point[]; moved: boolean; mode: 'draw' | 'erase' | 'tap' | 'lasso' } | null>(null);

  const toPoint = (e: PointerEvent | React.PointerEvent): Point => {
    const r = liveCanvas.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / scale,
      y: (e.clientY - r.top) / scale,
      p: e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 0.5,
    };
  };

  const eraseAt = (p: Point) => {
    const hits = useStore.getState().strokes.filter((s) => s.page === pageNum && hitStroke(s, p, 6));
    if (hits.length) useStore.getState().deleteStrokes(hits.map((s) => s.id));
  };

  const renderLive = (last = false) => {
    const d = drawing.current;
    const c = liveCanvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (d && d.mode === 'draw' && d.points.length) {
      drawStroke(ctx, { tool: tool === 'highlighter' ? 'highlighter' : 'pen', color, size, points: d.points }, scale, last);
    }
    if (d && d.mode === 'lasso' && d.points.length > 1) {
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7c3aed';
      ctx.fillStyle = 'rgba(124,58,237,.08)';
      ctx.beginPath();
      d.points.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (drawing.current) return;
    const isFinger = e.pointerType === 'touch';
    const mode = isFinger && !fingerDraw ? 'tap' : tool === 'eraser' ? 'erase' : tool === 'lasso' ? 'lasso' : 'draw';
    if (mode !== 'tap') {
      try {
        liveCanvas.current!.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer */
      }
    }
    const p = toPoint(e);
    drawing.current = { id: e.pointerId, points: [p], moved: false, mode };
    if (mode === 'erase') eraseAt(p);
    if (mode === 'draw') renderLive();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = toPoint(ev);
      d.moved = true;
      if (d.mode === 'erase') eraseAt(p);
      else if (d.mode === 'draw' || d.mode === 'lasso') d.points.push(p);
    }
    if (d.mode === 'draw' || d.mode === 'lasso') renderLive();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    if (d.mode === 'draw' && d.points.length) {
      useStore.getState().addStroke({
        page: pageNum,
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        color, size, points: d.points,
      });
    }
    if (d.mode === 'lasso') {
      const xs = d.points.map((p) => p.x);
      const ys = d.points.map((p) => p.y);
      const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
      if (bounds.maxX - bounds.minX > 8 && bounds.maxY - bounds.minY > 8) {
        const st = useStore.getState();
        let recId = st.activeRec?.id;
        let t = st.recTime();
        if (t == null) {
          // Not recording: anchor to the latest timed stroke inside the selection.
          const inside = strokes.filter((s) => {
            const b = strokeBounds(s);
            return s.t != null && b.minX >= bounds.minX && b.maxX <= bounds.maxX && b.minY >= bounds.minY && b.maxY <= bounds.maxY;
          });
          const last = inside.sort((a, b) => b.t! - a.t!)[0];
          recId = last?.recId;
          t = last?.t;
        }
        st.openAsk({ page: pageNum, bounds, recId, t });
      }
    }
    if (d.mode === 'tap' && !d.moved) {
      // Tap on a stroke → play the lecture audio from the moment it was written.
      const hit = [...shown].reverse().find((s) => s.t != null && s.recId && hitStroke(s, d.points[0], 10));
      if (hit) useStore.getState().playAt(hit.recId!, hit.t!);
    }
    renderLive(true);
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    if (drawing.current?.id === e.pointerId) {
      drawing.current = null;
      renderLive();
    }
  };

  const touchAction = fingerDraw ? 'none' : 'pan-x pan-y';

  return (
    <div ref={wrapRef} className="page" data-w1={width1} style={{ width: displayWidth, height: displayHeight }}>
      <canvas ref={pdfCanvas} className="layer" style={{ width: displayWidth, height: displayHeight }} />
      <canvas ref={inkCanvas} className="layer" style={{ width: displayWidth, height: displayHeight }} />
      <canvas
        ref={liveCanvas}
        className="layer live"
        style={{ width: displayWidth, height: displayHeight, touchAction }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      />
      {showOrder &&
        groups.map((g) => (
          <div
            key={g.index}
            className="order-badge"
            style={{ left: Math.max(0, g.bounds.minX * scale - 22), top: Math.max(0, g.bounds.minY * scale - 10) }}
          >
            {g.index}
          </div>
        ))}
      {flashBox && (
        <div
          className="flash"
          style={{ left: flashBox.x * scale, top: flashBox.y * scale, width: flashBox.w * scale, height: flashBox.h * scale }}
        />
      )}
      <div className="page-num">{pageNum}</div>
    </div>
  );
}
