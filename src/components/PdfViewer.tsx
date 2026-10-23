import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db';
import { groupStrokes } from '../ink';
import { currentPdf, loadPdf, type PDFDoc } from '../pdf';
import { useStore } from '../store';
import PageView from './PageView';

export default function PdfViewer({ docId, onMissing }: { docId: string; onMissing: () => void }) {
  const [pdf, setPdf] = useState<PDFDoc | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [containerW, setContainerW] = useState(800);
  const scrollRef = useRef<HTMLDivElement>(null);
  const strokes = useStore((s) => s.strokes);
  const zoom = useStore((s) => s.zoom);
  const scrollTo = useStore((s) => s.scrollTo);

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
        setSizes(s);
        currentPdf.doc = doc;
        setPdf(doc);
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

  const byPage = useMemo(() => {
    const m = new Map<number, typeof strokes>();
    for (const s of strokes) m.set(s.page, [...(m.get(s.page) ?? []), s]);
    return m;
  }, [strokes]);
  const groups = useMemo(() => groupStrokes(strokes), [strokes]);

  useEffect(() => {
    if (!scrollTo || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-page="${scrollTo.page}"]`);
    if (!el) return;
    const s = sizes[scrollTo.page - 1];
    const scale = (displayWidth * (s.w / maxW)) / s.w;
    scrollRef.current.scrollTo({ top: el.offsetTop + scrollTo.y * scale - 120, behavior: 'smooth' });
  }, [scrollTo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="empty">PDF를 열 수 없어요: {error}</div>;

  return (
    <div className="viewer" ref={scrollRef}>
      {!pdf && <div className="empty">PDF 불러오는 중…</div>}
      {pdf &&
        sizes.map((s, i) => (
          <div key={i} data-page={i + 1} className="page-slot">
            <PageView
              pdf={pdf}
              pageNum={i + 1}
              width1={s.w}
              height1={s.h}
              displayWidth={displayWidth * (s.w / maxW)}
              strokes={byPage.get(i + 1) ?? []}
              groups={groups.filter((g) => g.page === i + 1)}
            />
          </div>
        ))}
    </div>
  );
}
