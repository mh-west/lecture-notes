import { useEffect, useRef, useState } from 'react';
import type { Stroke } from '../db';
import { paintStroke } from '../inkImages';
import type { PDFDoc } from '../pdf';
import { useStore } from '../store';

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

/** One page rendered small with its ink; renders once it scrolls near view. */
function PageThumb({ pdf, pageNum, width, strokes, blankRatio = 1.3 }: {
  pdf: PDFDoc; pageNum: number; width: number; strokes: Stroke[]; blankRatio?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(width * 1.3);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '50% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      const c = canvas.current;
      if (!c) return;
      let scale: number;
      if (pageNum < 0) {
        // Blank page: white sheet with its ink. Ink is stored in units of the first PDF page's width.
        const w1 = (await pdf.getPage(1)).getViewport({ scale: 1 }).width;
        scale = width / w1;
        setHeight(width * blankRatio);
        c.width = Math.floor(width * dpr());
        c.height = Math.floor(width * blankRatio * dpr());
      } else {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const vp1 = page.getViewport({ scale: 1 });
        scale = width / vp1.width;
        setHeight(vp1.height * scale);
        const viewport = page.getViewport({ scale: scale * dpr() });
        c.width = Math.floor(viewport.width);
        c.height = Math.floor(viewport.height);
        task = page.render({ canvas: c, viewport });
        if (!(await task.promise.then(() => true, () => false))) return;
      }
      if (cancelled) return;
      const ctx = c.getContext('2d')!;
      ctx.scale(dpr(), dpr());
      for (const s of strokes) paintStroke(ctx, s, scale);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, pageNum, width, visible, strokes, blankRatio]);

  return <canvas ref={canvas} className="thumb-page" style={{ width, height }} />;
}

type OutlineItem = { title: string; page: number | null; items: OutlineItem[] };

async function loadOutline(pdf: PDFDoc): Promise<OutlineItem[]> {
  const raw = (await pdf.getOutline()) ?? [];
  const resolve = async (dest: unknown): Promise<number | null> => {
    try {
      const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(d) || !d[0]) return null;
      return typeof d[0] === 'number' ? d[0] + 1 : (await pdf.getPageIndex(d[0])) + 1;
    } catch {
      return null;
    }
  };
  type Raw = { title: string; dest: unknown; items: Raw[] };
  const walk = (items: Raw[]): Promise<OutlineItem[]> =>
    Promise.all(items.map(async (i) => ({ title: i.title, page: await resolve(i.dest), items: await walk(i.items ?? []) })));
  return walk(raw as Raw[]);
}

function OutlineRow({ pdf, item, depth }: { pdf: PDFDoc; item: OutlineItem; depth: number }) {
  const [open, setOpen] = useState(false);
  const goToPage = useStore((s) => s.goToPage);
  return (
    <>
      <div className="outline-row" style={{ paddingLeft: 12 + depth * 24 }}>
        <button className="chev" disabled={!item.items.length} onClick={() => setOpen(!open)}>
          {item.items.length ? (open ? '⌄' : '›') : ''}
        </button>
        <button className="outline-main" disabled={item.page == null} onClick={() => item.page && goToPage(item.page)}>
          {depth === 0 && item.page && <PageThumb pdf={pdf} pageNum={item.page} width={40} strokes={[]} />}
          <span className="outline-title">{item.title}</span>
          {item.page && <span className="outline-page">p.{item.page}</span>}
        </button>
      </div>
      {open && item.items.map((c, i) => <OutlineRow key={i} pdf={pdf} item={c} depth={depth + 1} />)}
    </>
  );
}

/** Goodnotes-style page browser: a thumbnail grid and the PDF's table of contents. */
export default function Overview({ pdf, order, sizes, byPage, currentPage }: {
  pdf: PDFDoc; order: number[]; sizes: { w: number; h: number }[]; byPage: Map<number, Stroke[]>; currentPage: () => number;
}) {
  const deleteBlankPage = useStore((s) => s.deleteBlankPage);
  const blankRatio = sizes[0] ? sizes[0].h / sizes[0].w : 1.3;
  const setOverview = useStore((s) => s.setOverview);
  const goToPage = useStore((s) => s.goToPage);
  const [tab, setTab] = useState<'pages' | 'outline'>('pages');
  const [current] = useState(currentPage); // page the viewer was on when this opened
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [grid, setGrid] = useState({ cols: 5, w: 130 });

  useEffect(() => {
    loadOutline(pdf).then(setOutline, () => setOutline([]));
  }, [pdf]);

  // Five compact columns on a landscape iPad, fewer when narrower.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      const cols = Math.max(2, Math.min(5, Math.floor(w / 160)));
      setGrid({ cols, w: Math.min(130, Math.floor((w - (cols - 1) * 48) / cols)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab]);

  useEffect(() => {
    if (tab === 'pages') gridRef.current?.querySelector('.thumb.current')?.scrollIntoView({ block: 'center' });
  }, [tab]);

  return (
    <div className="overview" onClick={(e) => e.target === e.currentTarget && setOverview(false)}>
      <div className="overview-panel">
        <header>
          <button className="plain" onClick={() => setOverview(false)}>닫기</button>
          <div className="segmented">
            <button className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>축소판</button>
            <button className={tab === 'outline' ? 'on' : ''} onClick={() => setTab('outline')}>개요</button>
          </div>
          <span className="plain" />
        </header>
        {tab === 'pages' ? (
          <div className="overview-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${grid.cols}, ${grid.w}px)` }}>
            {order.map((key, i) => (
              <div key={key} className={`thumb ${current === key ? 'current' : ''}`} role="button" onClick={() => goToPage(key)}>
                <PageThumb pdf={pdf} pageNum={key} width={grid.w} strokes={byPage.get(key) ?? []} blankRatio={blankRatio} />
                <span>
                  {i + 1}
                  {key < 0 && (
                    <button
                      className="thumb-delete"
                      title="빈 페이지 삭제"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`${i + 1}쪽 빈 페이지를 삭제할까요? 그 위의 필기도 함께 지워져요.`)) deleteBlankPage(key);
                      }}
                    >
                      삭제
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="outline">
            {outline == null && <div className="empty">불러오는 중…</div>}
            {outline?.length === 0 && <div className="empty">이 PDF에는 목차(개요)가 없어요.</div>}
            {outline?.map((item, i) => <OutlineRow key={i} pdf={pdf} item={item} depth={0} />)}
          </div>
        )}
      </div>
    </div>
  );
}
