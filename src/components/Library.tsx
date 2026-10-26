import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { db, importPdf, uid, type Course, type Doc } from '../db';
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
  const courses = useLiveQuery(() => db.courses.orderBy('createdAt').toArray(), []);
  const input = useRef<HTMLInputElement>(null);
  const [showFeatures, setShowFeatures] = useState(firstVisit);
  const [target, setTarget] = useState<string | undefined>(); // course the next picked PDFs go into
  const [editing, setEditing] = useState<Course | 'new' | null>(null);

  const pick = (courseId?: string) => {
    setTarget(courseId);
    input.current?.click();
  };

  const add = async (files: FileList | null) => {
    const list = Array.from(files ?? []); // copy: clearing the input empties the live FileList
    if (input.current) input.current.value = '';
    if (!list.length) return;
    let last = '';
    for (const f of list) last = await importPdf(f, f.name, target);
    if (list.length === 1) onOpen(last);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`"${name}" 문서와 필기·녹음·자막·질문을 모두 삭제할까요?`)) return;
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

  const move = (id: string, courseId: string) => db.docs.update(id, { courseId: courseId || undefined });

  const sections: { course: Course | null; docs: Doc[] }[] = [
    ...(courses ?? []).map((c) => ({ course: c, docs: (docs ?? []).filter((d) => d.courseId === c.id) })),
  ];
  const unfiled = (docs ?? []).filter((d) => !d.courseId || !courses?.some((c) => c.id === d.courseId));
  if (unfiled.length || !courses?.length) sections.push({ course: null, docs: unfiled });

  return (
    <div className="library">
      <header>
        <h1>강의 노트</h1>
        <div className="row-wrap">
          <button onClick={() => setShowFeatures(true)}>이 앱으로 할 수 있는 것</button>
          <button onClick={() => setEditing('new')}>+ 과목 폴더</button>
          <button className="primary" onClick={() => pick(undefined)}>+ PDF 추가</button>
        </div>
        <input ref={input} type="file" accept="application/pdf" multiple hidden onChange={(e) => add(e.target.files)} />
      </header>
      <ExpiryBanner />
      {docs && !docs.length && !courses?.length && (
        <p className="empty">
          과목 폴더를 만들고 강의 PDF를 넣어보세요. 폴더에 적은 과목 정보와 용어가 그 폴더 PDF의 자막 인식과 요약에 쓰여요.
        </p>
      )}

      {sections.map(({ course, docs: list }) => (
        <section key={course?.id ?? 'unfiled'} className="course">
          <div className="course-head">
            <div className="course-title">
              <span className="folder">📁</span>
              <b>{course?.name ?? '분류 안 됨'}</b>
              {course && <span className="badge">{course.lang === 'ko-KR' ? '한국어' : 'English'}</span>}
              <span className="muted">{list.length}개</span>
            </div>
            <div className="row-wrap">
              {course && <button onClick={() => setEditing(course)}>⚙ 과목 설정</button>}
              <button onClick={() => pick(course?.id)}>+ PDF</button>
            </div>
          </div>
          {course?.subject && <div className="course-subject muted">{course.subject}</div>}
          <ul className="doc-list">
            {list.map((d) => (
              <li key={d.id}>
                <button className="doc" onClick={() => onOpen(d.id)}>
                  <span className="doc-icon">📄</span>
                  <span className="doc-name">{d.name}</span>
                  <span className="muted">{new Date(d.updatedAt).toLocaleDateString('ko-KR')}</span>
                </button>
                {!!courses?.length && (
                  <select value={d.courseId ?? ''} onChange={(e) => move(d.id, e.target.value)} aria-label="과목 폴더로 이동">
                    <option value="">분류 안 됨</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
                <button className="danger" onClick={() => remove(d.id, d.name)} aria-label="삭제">✕</button>
              </li>
            ))}
            {!list.length && <li className="muted empty-row">PDF가 없어요</li>}
          </ul>
        </section>
      ))}

      {showFeatures && <Features onClose={() => setShowFeatures(false)} />}
      {editing && <CourseDialog course={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CourseDialog({ course, onClose }: { course: Course | null; onClose: () => void }) {
  const [name, setName] = useState(course?.name ?? '');
  const [subject, setSubject] = useState(course?.subject ?? '');
  const [lang, setLang] = useState<Course['lang']>(course?.lang ?? 'en-US');
  const [vocab, setVocab] = useState((course?.vocab ?? []).join(', '));

  // Terms already auto-extracted from this folder's PDFs, offered as one-tap additions.
  const suggested = useLiveQuery(async () => {
    if (!course) return [];
    const docs = await db.docs.where('courseId').equals(course.id).toArray();
    const count = new Map<string, number>();
    for (const d of docs) for (const t of d.terms ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t]) => t);
  }, [course?.id]);

  const terms = vocab.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
  const addTerm = (t: string) => !terms.includes(t) && setVocab([...terms, t].join(', '));

  const save = async () => {
    if (!name.trim()) return;
    const data = { name: name.trim(), subject: subject.trim(), lang, vocab: terms };
    if (course) await db.courses.update(course.id, data);
    else await db.courses.put({ id: uid(), createdAt: Date.now(), ...data });
    onClose();
  };

  const remove = async () => {
    if (!course || !confirm(`"${course.name}" 폴더를 삭제할까요? 안의 PDF는 "분류 안 됨"으로 옮겨져요.`)) return;
    await db.transaction('rw', [db.docs, db.courses], async () => {
      await db.docs.where('courseId').equals(course.id).modify({ courseId: undefined });
      await db.courses.delete(course.id);
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{course ? '과목 설정' : '새 과목 폴더'}</h2>
          <button onClick={onClose} aria-label="닫기">✕</button>
        </header>
        <label className="field">
          과목 이름
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: Stochastic Differential Equations" />
        </label>
        <label className="field">
          수업 언어 (자막 인식 기본값)
          <div className="seg">
            <button className={lang === 'en-US' ? 'active' : ''} onClick={() => setLang('en-US')}>English</button>
            <button className={lang === 'ko-KR' ? 'active' : ''} onClick={() => setLang('ko-KR')}>한국어</button>
          </div>
        </label>
        <label className="field">
          과목 정보 <span className="muted">— 요약·AI 질문에 함께 전달돼요</span>
          <textarea
            rows={3}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="예: 대학원 수준, 측도론 기반 확률론 선수. Itô calculus, SDE 해의 존재·유일성, Girsanov, Feynman–Kac 다룸."
          />
        </label>
        <label className="field">
          주요 용어 <span className="muted">— 쉼표나 줄바꿈으로 구분, 자막 인식 힌트로 쓰여요</span>
          <textarea rows={3} value={vocab} onChange={(e) => setVocab(e.target.value)} placeholder="예: Itô integral, martingale, quadratic variation, 이토 적분" />
        </label>
        {!!suggested?.length && (
          <div className="field">
            <span className="muted">이 폴더 PDF에서 찾은 용어 (누르면 추가 — 추가 안 해도 자동으로 인식 힌트에 들어가요)</span>
            <div className="chips">
              {suggested.map((t) => (
                <button key={t} className={terms.includes(t) ? 'active small-chip' : 'small-chip'} onClick={() => addTerm(t)}>{t}</button>
              ))}
            </div>
          </div>
        )}
        <button className="primary big" onClick={save} disabled={!name.trim()}>저장</button>
        {course && <button className="danger" onClick={remove}>폴더 삭제</button>}
      </div>
    </div>
  );
}
