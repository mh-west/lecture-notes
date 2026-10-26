import { useLiveQuery } from 'dexie-react-hooks';
import { useRef } from 'react';
import { db, importPdf } from '../db';

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const docs = useLiveQuery(() => db.docs.orderBy('updatedAt').reverse().toArray(), []);
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    let last = '';
    for (const f of Array.from(files)) {
      last = await importPdf(f, f.name);
    }
    if (files.length === 1) onOpen(last);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`"${name}" 문서와 필기·녹음을 모두 삭제할까요?`)) return;
    const recs = await db.recordings.where('docId').equals(id).primaryKeys();
    await db.transaction('rw', [db.docs, db.strokes, db.recordings, db.chunks], async () => {
      await db.strokes.where('docId').equals(id).delete();
      for (const r of recs) await db.chunks.where('recId').equals(r).delete();
      await db.recordings.bulkDelete(recs);
      await db.docs.delete(id);
    });
  };

  return (
    <div className="library">
      <header>
        <h1>강의 노트</h1>
        <button className="primary" onClick={() => input.current?.click()}>+ PDF 추가</button>
        <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => add(e.target.files)} />
      </header>
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
    </div>
  );
}
