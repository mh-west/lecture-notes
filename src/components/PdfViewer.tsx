import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { db, uid, type Stroke } from '../db';
import { groupStrokes } from '../ink';
import { nativeStrokes, pinching, setPinching, startInertia, stopInertia } from '../gestures';
import { addInkImage } from '../inkImages';
import { isNative, LectureAudio, type InkStrokeEvent } from '../native';
import { currentPdf, loadPdf, type PDFDoc } from '../pdf';
import { ensureDocTerms } from '../terms';
import { useStore } from '../store';
import Overview from './Overview';
import PageView from './PageView';

let scrollRaf = 0;

/** Put a finished PencilKit stroke on the page under it, in PDF units, keeping PencilKit's rendering. */
async function placeInk(e: InkStrokeEvent) {
  const ack = () => LectureAudio.clearInkPreview().catch(() => {});
  const first = e.points[0];
  const page = first && document.elementFromPoint(first.x, first.y)?.closest<HTMLElement>('.page');
  const slot = page?.closest<HTMLElement>('.page-slot');
  const st = useStore.getState();
  if (!page || !slot || (st.tool !== 'pen' && st.tool !== 'highlighter')) return ack(); // off the pages
  const r = page.getBoundingClientRect();
  const scale = r.width / Number(page.dataset.w1);
  const id = uid();
  await addInkImage(id, +scale.toFixed(2), e.png);
  nativeStrokes.add(id); // the page acknowledges when it has drawn it
  const stroke = st.addStroke(
    {
      page: Number(slot.dataset.page),
      tool: st.tool,
      color: st.color,
      size: st.size,
      points: e.points.map((q) => ({ x: (q.x - r.left) / scale, y: (q.y - r.top) / scale, p: q.p })),
      pk: {
        data: e.data,
        bounds: { x: (e.bounds.x - r.left) / scale, y: (e.bounds.y - r.top) / scale, w: e.bounds.w / scale, h: e.bounds.h / scale },
        scale: +scale.toFixed(2),
      },
    },
    { at: e.startedAt, id },
  );
  if (!stroke) {
    nativeStrokes.delete(id);
    ack();
  }
}

/** Where the reader is: the page at the top of the viewer and how far into it (0..1), so it survives zoom. */
type Spot = { page: number; frac: number };
const spotKey = (docId: string) => `spot:${docId}`;

/** A spot on a page, as fractions of its size, so it can be found again after the zoom changes. */
type Anchor = { page: string; fx: number; fy: number };
function pageAt(el: HTMLElement, x: number, y: number): Anchor | null {
  let best: Anchor | null = null;
  let bestD = Infinity;
  for (const p of el.querySelectorAll<HTMLElement>('[data-page] > .page')) {
    const b = p.getBoundingClientRect();
    const d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
    if (d < bestD) {
      bestD = d;
      best = { page: p.parentElement!.dataset.page!, fx: (x - b.left) / b.width, fy: (y - b.top) / b.height };
    }
  }
  return best;
}
function loadSpot(docId: string): Spot | null {
  try {
    return JSON.parse(localStorage.getItem(spotKey(docId)) ?? 'null');
  } catch {
    return null;
  }
}
function saveSpot(docId: string, spot: Spot) {
  try {
    localStorage.setItem(spotKey(docId), JSON.stringify(spot));
  } catch {
    /* storage unavailable: the position just isn't remembered */
  }
}
const NO_GROUPS: ReturnType<typeof groupStrokes> = [];
const NO_STROKES: Stroke[] = [];

export default function PdfViewer({ docId, onMissing }: { docId: string; onMissing: () => void }) {
  const [pdf, setPdf] = useState<PDFDoc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [containerW, setContainerW] = useState(800);
  const scrollRef = useRef<HTMLDivElement>(null);
  const strokes = useStore((s) => s.strokes);
  const zoom = useStore((s) => s.zoom);
  const scrollTo = useStore((s) => s.scrollTo);
  const overview = useStore((s) => s.overview);
  const order = useStore((s) => s.pageOrder);
  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const size = useStore((s) => s.size);
  const asking = useStore((s) => s.ask != null);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let doc: PDFDoc | null = null;
    let cancelled = false;
    (async () => {
      try {
        const rec = await db.docs.get(docId);
        if (!rec) return onMissing();
        doc = await loadPdf(rec.pdf);
        const s: { w: number; h: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
          s.push({ w: vp.width, h: vp.height });
        }
        if (cancelled) return void doc.loadingTask.destroy();
        const saved = rec.pages?.filter((k) => k < 0 || k <= s.length);
        useStore.getState().setPageOrder(saved?.length ? saved : s.map((_, i) => i + 1));
        setSizes(s);
        currentPdf.doc = doc;
        currentPdf.ocr = rec.ocrPages; // scanned PDF: page text read earlier with OCR
        setPdf(doc);
        ensureDocTerms(rec, doc).catch(() => {}); // background: speech hints for this lecture
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      doc?.loadingTask.destroy();
    };
  }, [docId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setContainerW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const displayWidth = Math.max(200, (containerW - 32) * zoom);
  const maxW = Math.max(...sizes.map((s) => s.w), 1);

  // Is a dialog covering the pages? Then the native ink layer must not take touches meant for it.
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    const check = () => setModalOpen(Boolean(document.querySelector('.modal-backdrop')));
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
  const fingerDraw = useStore((s) => s.fingerDraw);

  // The iPad's PencilKit layer covers the pages while the pen or highlighter is in use (see InkLayer).
  useEffect(() => {
    const el = scrollRef.current;
    if (!isNative || !el) return;
    const send = () => {
      const r = el.getBoundingClientRect();
      const hl = tool === 'highlighter';
      LectureAudio.setInkPreview({
        enabled: (tool === 'pen' || hl) && !overview && !asking && !modalOpen && !fingerDraw,
        color,
        width: size * (displayWidth / maxW),
        highlighter: hl,
        area: { x: r.left, y: r.top, w: r.width, h: r.height },
      }).catch(() => {});
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(document.body);
    return () => {
      ro.disconnect();
      // Off whenever this view goes away (back to the library, say), or it would keep taking touches there.
      LectureAudio.setInkPreview({ enabled: false, color, width: 1, highlighter: false, area: { x: 0, y: 0, w: 0, h: 0 } }).catch(() => {});
    };
  }, [tool, color, size, displayWidth, maxW, containerW, overview, asking, modalOpen, fingerDraw]);

  // Pinch zoom, shared by web touches and the native layer's forwarded pinch: scale the pages with a
  // CSS transform while pinching (cheap), then apply the real zoom once and keep the spot between the
  // fingers where it was.
  const pinch = useRef<{ zoom: number; cx: number; cy: number; ox: number; oy: number; s: number; anchor: Anchor | null } | null>(null);
  const pinchBegin = (clientX: number, clientY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    stopInertia();
    setPinching(true);
    const r = el.getBoundingClientRect();
    const cx = clientX - r.left;
    const cy = clientY - r.top;
    const pages = pagesRef.current;
    // ox, oy: the point under the fingers, in the pages container's own coordinates.
    const ox = el.scrollLeft + cx - (pages?.offsetLeft ?? 0);
    const oy = el.scrollTop + cy - (pages?.offsetTop ?? 0);
    pinch.current = { zoom: useStore.getState().zoom, cx, cy, ox, oy, s: 1, anchor: pageAt(el, clientX, clientY) };
    if (pages) pages.style.transformOrigin = `${ox}px ${oy}px`;
  };
  const pinchScale = (scale: number) => {
    const p = pinch.current;
    if (!p) return;
    p.s = Math.min(3, Math.max(0.6, p.zoom * scale)) / p.zoom;
    if (pagesRef.current) pagesRef.current.style.transform = `scale(${p.s})`;
  };
  const pinchEnd = () => {
    const p = pinch.current;
    if (!p) return;
    pinch.current = null;
    setPinching(false);
    stopInertia(); // nothing may keep scrolling once the zoom lands
    if (pagesRef.current) pagesRef.current.style.transform = '';
    const next = +(p.zoom * p.s).toFixed(2);
    if (next === p.zoom) return;
    // Applied in the layout effect below, once the pages have their new size.
    pinchFocus.current = { ox: p.ox, oy: p.oy, s: next / p.zoom, cx: p.cx, cy: p.cy, anchor: p.anchor };
    useStore.getState().setZoom(next);
  };
  const handlers = useRef({ pinchBegin, pinchScale, pinchEnd });
  handlers.current = { pinchBegin, pinchScale, pinchEnd };

  // Web touches (browser, or the iPad when the ink layer is off).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let d0 = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const fingers = (t: TouchList) =>
      t.length === 2 && Array.from(t).every((x) => (x as Touch & { touchType?: string }).touchType !== 'stylus');
    const onStart = (e: TouchEvent) => {
      if (!fingers(e.touches)) return;
      d0 = dist(e.touches);
      handlers.current.pinchBegin((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
    };
    const onMove = (e: TouchEvent) => {
      if (d0 && e.touches.length === 2) handlers.current.pinchScale(dist(e.touches) / d0);
    };
    const onEnd = (e: TouchEvent) => {
      if (!d0 || e.touches.length >= 2) return;
      d0 = 0;
      handlers.current.pinchEnd();
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    // Passive on purpose: a blocking touch listener makes WebKit hold every touch (and the app's main
    // thread) until the page's script has run, which is what made the pencil start late.
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Native ink layer: finished pencil strokes, and finger gestures it forwards.
  useEffect(() => {
    const el = scrollRef.current;
    if (!isNative || !el) return;
    let panStart = { left: 0, top: 0 };
    const subs = [
      LectureAudio.addListener('inkStroke', (e) => {
        placeInk(e).finally(() => {}); // acknowledges itself once drawn (or right away if off the pages)
      }),
      LectureAudio.addListener('fingerPan', (e) => {
        if (pinching) return; // a pinch is in charge of the view
        if (e.state === 'began') {
          stopInertia();
          panStart = { left: el.scrollLeft, top: el.scrollTop };
        }
        el.scrollLeft = panStart.left - e.dx;
        el.scrollTop = panStart.top - e.dy;
        if (e.state === 'ended' && Math.hypot(e.vx, e.vy) > 60) startInertia(el, -e.vx / 1000, -e.vy / 1000);
      }),
      LectureAudio.addListener('fingerPinch', (e) => {
        if (e.state === 'began') handlers.current.pinchBegin(e.x, e.y);
        else if (e.state === 'changed') handlers.current.pinchScale(e.scale);
        else handlers.current.pinchEnd();
      }),
      LectureAudio.addListener('fingerTap', (e) => {
        // A tap on a stroke plays the lecture from when it was written: hand it to the page as a touch.
        const target = document.elementFromPoint(e.x, e.y);
        if (!target) return;
        const opts = { bubbles: true, pointerId: 9999, pointerType: 'touch', clientX: e.x, clientY: e.y, isPrimary: true };
        // Buttons floating over the pages (reopen panel, caption bar) get a real click.
        const control = target.closest<HTMLElement>('button, a, select, input, [role="button"], .caption-text');
        if (control) return control.click();
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
      }),
    ];
    return () => subs.forEach((p) => p.then((h) => h.remove()));
  }, []);

  // Reopen where the reader left off, and keep that spot when the page width changes (zoom, rotation).
  const spot = useRef<Spot | null>(null);
  const pinchFocus = useRef<{ ox: number; oy: number; s: number; cx: number; cy: number; anchor: Anchor | null } | null>(null);
  useEffect(() => {
    spot.current = loadSpot(docId);
  }, [docId]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const f = pinchFocus.current;
    if (el && f) {
      // After a pinch, keep the point that was between the fingers where it was.
      pinchFocus.current = null;
      // Pages are centered, so the container doesn't grow in proportion: put the same spot of the
      // same page back under the fingers rather than scaling container coordinates.
      const page = f.anchor && el.querySelector<HTMLElement>(`[data-page="${f.anchor.page}"] .page`);
      if (page && f.anchor) {
        const b = page.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        el.scrollLeft += b.left + f.anchor.fx * b.width - (r.left + f.cx);
        el.scrollTop += b.top + f.anchor.fy * b.height - (r.top + f.cy);
      } else {
        const pages = pagesRef.current;
        el.scrollLeft = f.ox * f.s + (pages?.offsetLeft ?? 0) - f.cx;
        el.scrollTop = f.oy * f.s + (pages?.offsetTop ?? 0) - f.cy;
      }
      return;
    }
    const s = spot.current;
    if (!pdf || !el || !s) return;
    const slot = el.querySelector<HTMLElement>(`[data-page="${s.page}"]`);
    if (slot) el.scrollTop = slot.offsetTop + s.frac * slot.offsetHeight;
  }, [pdf, displayWidth]);

  const byPage = useMemo(() => {
    const m = new Map<number, typeof strokes>();
    for (const s of strokes) m.set(s.page, [...(m.get(s.page) ?? []), s]);
    return m;
  }, [strokes]);
  const groupsByPage = useMemo(() => {
    const m = new Map<number, ReturnType<typeof groupStrokes>>();
    for (const g of groupStrokes(strokes)) m.set(g.page, [...(m.get(g.page) ?? []), g]);
    return m;
  }, [strokes]);

  useEffect(() => {
    if (!scrollTo || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-page="${scrollTo.page}"]`);
    if (!el) return;
    if (scrollTo.jump) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 16 });
      return;
    }
    const s = sizes[scrollTo.page - 1];
    const scale = (displayWidth * (s.w / maxW)) / s.w;
    scrollRef.current.scrollTo({ top: el.offsetTop + scrollTo.y * scale - 120, behavior: 'smooth' });
  }, [scrollTo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The page whose slot spans the middle of the viewer.
  const currentPage = () => {
    const el = scrollRef.current;
    if (!el) return 1;
    const mid = el.scrollTop + el.clientHeight / 2;
    const slots = el.querySelectorAll<HTMLElement>('.page-slot');
    for (const slot of slots) if (slot.offsetTop + slot.offsetHeight > mid) return Number(slot.dataset.page);
    return Number(slots[slots.length - 1]?.dataset.page ?? 1);
  };

  if (error) return <div className="empty">PDF를 열 수 없어요: {error}</div>;

  return (
    <div
      className="viewer"
      ref={scrollRef}
      onScroll={() => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = 0;
          useStore.getState().setViewPage(currentPage());
          const el = scrollRef.current;
          const slot = el && [...el.querySelectorAll<HTMLElement>('.page-slot')].find((x) => x.offsetTop + x.offsetHeight > el.scrollTop);
          if (el && slot) {
            spot.current = { page: Number(slot.dataset.page), frac: Math.max(0, (el.scrollTop - slot.offsetTop) / slot.offsetHeight) };
            saveSpot(docId, spot.current);
          }
        });
      }}
    >
      {!pdf && <div className="empty">PDF 불러오는 중…</div>}
      <div className="pages" ref={pagesRef}>
      {pdf &&
        sizes.length > 0 &&
        order.map((key, i) => {
          const s = key > 0 ? sizes[key - 1] : sizes[0]; // blank pages take the first page's size
          return (
            <div key={key} data-page={key} className="page-slot">
              <PageView
                pdf={pdf}
                pageNum={key}
                label={i + 1}
                width1={s.w}
                height1={s.h}
                displayWidth={displayWidth * (s.w / maxW)}
                strokes={byPage.get(key) ?? NO_STROKES}
                groups={groupsByPage.get(key) ?? NO_GROUPS}
              />
            </div>
          );
        })}
      </div>
      {pdf && overview && <Overview pdf={pdf} order={order} sizes={sizes} byPage={byPage} currentPage={currentPage} />}
    </div>
  );
}
