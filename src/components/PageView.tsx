import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Point, Stroke } from '../db';
import { drawStroke, hitStroke, strokeBounds, type StrokeGroup } from '../ink';
import type { PDFDoc } from '../pdf';
import { inkVersion, onInkImages, paintStroke } from '../inkImages';
import { isNative, LectureAudio } from '../native';
import { nativeStrokes } from '../gestures';
import { pinching, startInertia, stopInertia } from '../gestures';
import { useStore } from '../store';

const ERASER_R = 10; // eraser radius in PDF units

interface Props {
  pdf: PDFDoc;
  pageNum: number; // page key: PDF page number, or negative for an added blank page
  label: number; // position shown to the reader
  width1: number; // page size at scale 1
  height1: number;
  displayWidth: number;
  strokes: Stroke[];
  groups: StrokeGroup[];
}

export default function PageView({ pdf, pageNum, label, width1, height1, displayWidth, strokes, groups }: Props) {
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

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Lazy-render pages near the viewport.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '100% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Offscreen pages give their canvas memory back; iPad WebKit stutters (and drops canvases) when it runs low.
  useEffect(() => {
    if (visible) return;
    for (const c of [pdfCanvas.current, inkCanvas.current, liveCanvas.current]) {
      if (c) c.width = c.height = 0;
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      if (pageNum < 0) {
        // Blank page: plain white, at the same resolution a PDF page would have (lasso crops read it).
        const c = pdfCanvas.current;
        if (!c) return;
        c.width = Math.floor(width1 * scale * dpr);
        c.height = Math.floor(height1 * scale * dpr);
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        return;
      }
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;
      const viewport = page.getViewport({ scale: scale * dpr });
      // Render offscreen and swap in, so a zoom change doesn't blank the page mid-render.
      const off = document.createElement('canvas');
      off.width = Math.floor(viewport.width);
      off.height = Math.floor(viewport.height);
      task = page.render({ canvas: off, viewport });
      const ok = await task.promise.then(() => true, () => false);
      const c = pdfCanvas.current;
      if (!ok || cancelled || !c) return;
      c.width = off.width;
      c.height = off.height;
      c.getContext('2d')!.drawImage(off, 0, 0);
      off.width = off.height = 0;
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNum, scale, dpr, visible, width1, height1]);

  const shown = useMemo(() => {
    if (replayT == null) return strokes;
    return strokes.filter((s) => s.recId === playingRecId && s.t != null && s.t <= replayT);
  }, [strokes, replayT, playingRecId]);

  // Committed ink. A new stroke only adds to what is already drawn; anything else (erase, undo, zoom) redraws.
  const drawn = useRef<{ strokes: Stroke[]; scale: number; v: number }>({ strokes: [], scale: 0, v: 0 });
  const [imagesV, setImagesV] = useState(inkVersion);
  useEffect(() => onInkImages(() => setImagesV(inkVersion())), []);
  // Layout effect: the finished stroke lands on the ink layer in the same frame the live layer is cleared.
  useLayoutEffect(() => {
    if (!visible) {
      drawn.current = { strokes: [], scale: 0, v: 0 };
      return;
    }
    const c = inkCanvas.current!;
    const w = Math.floor(displayWidth * dpr);
    const h = Math.floor(displayHeight * dpr);
    const ctx = c.getContext('2d')!;
    const prev = drawn.current;
    const appended = c.width === w && c.height === h && prev.scale === scale && prev.v === imagesV &&
      shown.length >= prev.strokes.length && prev.strokes.every((s, i) => shown[i] === s);
    if (!appended) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const added = appended ? shown.slice(prev.strokes.length) : shown;
    for (const s of added) paintStroke(ctx, s, scale);
    // A PencilKit stroke is now on the page: remove it from the native ink layer.
    for (const s of added) {
      if (nativeStrokes.delete(s.id)) LectureAudio.clearInkPreview().catch(() => {});
    }
    drawn.current = { strokes: shown, scale, v: imagesV };
  }, [shown, scale, displayWidth, displayHeight, dpr, visible, imagesV]);

  useEffect(() => {
    if (!visible) return;
    const c = liveCanvas.current!;
    c.width = Math.floor(displayWidth * dpr);
    c.height = Math.floor(displayHeight * dpr);
  }, [displayWidth, displayHeight, dpr, visible]);

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

  const drawing = useRef<{ id: number; points: Point[]; moved: boolean; mode: 'draw' | 'erase' | 'tap' | 'lasso'; pen: boolean } | null>(null);

  const rect = useRef<DOMRect | null>(null); // measured once per stroke; reading layout per event is slow
  const toPoint = (e: PointerEvent | React.PointerEvent): Point => {
    const r = rect.current ?? liveCanvas.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / scale,
      y: (e.clientY - r.top) / scale,
      p: e.pointerType === 'pen' ? Math.max(0.05, e.pressure) : 0.5,
    };
  };

  const eraseAt = (p: Point) => {
    const hits = useStore.getState().strokes.filter((s) => s.page === pageNum && hitStroke(s, p, ERASER_R));
    if (hits.length) useStore.getState().deleteStrokes(hits.map((s) => s.id));
  };

  const frame = useRef(0);
  const scheduleLive = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      renderLive();
    });
  };

  // Area (CSS px) painted on the live layer last frame; only that is cleared, not the whole page.
  const liveDirty = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const renderLive = (last = false) => {
    const d = drawing.current;
    const c = liveCanvas.current!;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const old = liveDirty.current;
    if (old) ctx.clearRect(old.x0, old.y0, old.x1 - old.x0, old.y1 - old.y0);
    liveDirty.current = null;
    if (d && d.points.length && (d.mode === 'draw' || d.mode === 'lasso' || d.mode === 'erase')) {
      const pad = Math.max(size * scale * 4, ERASER_R * scale) + 8;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of d.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      liveDirty.current = { x0: x0 * scale - pad, y0: y0 * scale - pad, x1: x1 * scale + pad, y1: y1 * scale + pad };
    }
    // On the iPad the app draws pencil strokes natively while they're written (see InkPreview).
    if (d && d.mode === 'draw' && d.points.length && !(isNative && d.pen)) {
      drawStroke(ctx, { tool: tool === 'highlighter' ? 'highlighter' : 'pen', color, size, points: d.points }, scale, last);
    }
    if (d && d.mode === 'erase' && d.points.length) {
      // Show what the eraser covers.
      const p = d.points[d.points.length - 1];
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x * scale, p.y * scale, ERASER_R * scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(148,163,184,.18)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(71,85,105,.8)';
      ctx.stroke();
      ctx.restore();
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
    // A resting palm may already be "scrolling" when the pencil lands: the pencil wins.
    if (drawing.current && !(e.pointerType === 'pen' && drawing.current.mode === 'tap')) return;
    pan.current = null;
    const isFinger = e.pointerType === 'touch';
    const mode = isFinger && !fingerDraw ? 'tap' : tool === 'eraser' ? 'erase' : tool === 'lasso' ? 'lasso' : 'draw';
    try {
      liveCanvas.current!.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    stopInertia();
    if (mode === 'tap') {
      const v = liveCanvas.current!.closest<HTMLElement>('.viewer')!;
      pan.current = { v, x: e.clientX, y: e.clientY, left: v.scrollLeft, top: v.scrollTop, t: e.timeStamp, vx: 0, vy: 0 };
    }
    rect.current = liveCanvas.current!.getBoundingClientRect();
    const p = toPoint(e);
    drawing.current = { id: e.pointerId, points: [p], moved: false, mode, pen: e.pointerType === 'pen' };
    if (mode === 'erase') eraseAt(p);
    if (mode === 'draw' || mode === 'erase') renderLive();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    if (d.mode === 'tap') return panMove(d, e);
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = toPoint(ev);
      d.moved = true;
      if (d.mode === 'erase') {
        eraseAt(p);
        d.points = [p];
      } else d.points.push(p);
    }
    scheduleLive();
  };

  // Finger scrolling. The page canvas has touch-action: none so the pencil isn't held back while the
  // browser decides whether a touch is a scroll; fingers therefore scroll the viewer by hand.
  const pan = useRef<{ v: HTMLElement; x: number; y: number; left: number; top: number; t: number; vx: number; vy: number } | null>(null);
  const panMove = (d: NonNullable<typeof drawing.current>, e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    if (pinching) {
      d.moved = true; // a pinch is never a tap
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    d.moved = true;
    const prevLeft = p.v.scrollLeft;
    const prevTop = p.v.scrollTop;
    p.v.scrollLeft = p.left - dx;
    p.v.scrollTop = p.top - dy;
    const dt = Math.max(1, e.timeStamp - p.t);
    // Smoothed velocity in px/ms, for the fling when the finger lifts.
    p.vx = 0.8 * ((p.v.scrollLeft - prevLeft) / dt) + 0.2 * p.vx;
    p.vy = 0.8 * ((p.v.scrollTop - prevTop) / dt) + 0.2 * p.vy;
    p.t = e.timeStamp;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d || d.id !== e.pointerId) return;
    drawing.current = null;
    rect.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
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
    if (d.mode === 'tap' && d.moved && pan.current) {
      const { v, vx, vy } = pan.current;
      if (e.timeStamp - pan.current.t < 80) startInertia(v, vx, vy);
    }
    pan.current = null;
    if (d.mode === 'tap' && !d.moved) {
      // Tap on a stroke → play the lecture audio from the moment it was written.
      const hit = [...shown].reverse().find((s) => s.t != null && s.recId && hitStroke(s, d.points[0], 10));
      if (hit) useStore.getState().playAt(hit.recId!, hit.t!);
    }
    renderLive(true);
  };

  // iOS cancels a pointer when it decides the touch is a gesture; keep what was written instead of dropping it.
  const onPointerCancel = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (d?.id !== e.pointerId) return;
    if (d.mode === 'draw' && d.points.length > 1) return onPointerUp(e);
    drawing.current = null;
    rect.current = null;
    renderLive();
  };

  const touchAction = 'none';

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
      {/* PDF pages carry their own printed numbers; only added blank pages get a label. */}
      {pageNum < 0 && <div className="page-num">빈 페이지 · {label}</div>}
    </div>
  );
}
