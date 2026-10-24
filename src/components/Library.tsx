import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { db, uid } from '../db';
import ExpiryBanner from './ExpiryBanner';
import Features from './Features';

const SEEN_KEY = 'featuresSeen';
function firstVisit() {
  try {
    if (localStorage.getItem(SEEN_KEY)) return false;
    localStorage.setItem(SEEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const docs = useLiveQuery(() => db.docs.orderBy('updatedAt').reverse().toArray(), []);
  const input = useRef<HTMLInputElement>(null);
  const [showFeatures, setShowFeatures] = useState(firstVisit);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    let last = '';
    for (const f of Array.from(files)) {
      const id = uid();
      await db.docs.put({ id, name: f.name.replace(/\.pdf$/i, ''), pdf: f, createdAt: Date.now(), updatedAt: Date.now() });
      last = id;
    }
    if (files.length === 1) onOpen(last);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`"${name}" 문서와 필기·녹음을 모두 삭제할까요?`)) return;
    const recs = await db.recordings.where('docId').equals(id).primaryKeys();
    await db.transaction('rw', [db.docs, db.strokes, db.recordings, db.chunks, db.segments, db.questions, db.summaries], async () => {
      await db.strokes.where('docId').equals(id).delete();
      await db.segments.where('docId').equals(id).delete();
      await db.questions.where('docId').equals(id).delete();
      await db.summaries.where('docId').equals(id).delete();
      for (const r of recs) await db.chunks.where('recId').equals(r).delete();
      await db.recordings.bulkDelete(recs);
      await db.docs.delete(id);
    });
  };

  return (
    <div className="library">
      <header>
        <h1>강의 노트</h1>
        <div className="row-wrap">
          <button onClick={() => setShowFeatures(true)}>이 앱으로 할 수 있는 것</button>
          <button className="primary" onClick={() => input.current?.click()}>+ PDF 추가</button>
        </div>
        <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => add(e.target.files)} />
      </header>
      <ExpiryBanner />
      {docs && !docs.length && <p className="empty">강의 PDF를 추가해서 시작하세요.</p>}
      <ul className="doc-list">
        {docs?.map((d) => (
          <li key={d.id}>
            <button className="doc" onClick={() => onOpen(d.id)}>
              <span className="doc-icon">📄</span>
              <span className="doc-name">{d.name}</span>
              <span className="muted">{new Date(d.updatedAt).toLocaleDateString('ko-KR')}</span>
            </button>
            <button className="danger" onClick={() => remove(d.id, d.name)} aria-label="삭제">✕</button>
          </li>
        ))}
      </ul>
      {showFeatures && <Features onClose={() => setShowFeatures(false)} />}
    </div>
  );
}
