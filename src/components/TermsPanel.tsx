import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db } from '../db';
import { docTerms, recognitionVocabulary } from '../terms';
import { useStore } from '../store';

/**
 * The lecture terms behind captions, translation and summaries: this PDF's own list (auto-extracted,
 * editable), the folder's terms, and the final combined list that is actually used.
 */
export default function TermsPanel() {
  const docId = useStore((s) => s.docId);
  const course = useStore((s) => s.course);
  const lang = useStore((s) => s.lang);
  const doc = useLiveQuery(() => (docId ? db.docs.get(docId) : undefined), [docId]);
  const used = useLiveQuery(() => (docId ? recognitionVocabulary(docId, course, lang) : []), [docId, course, lang, doc]);
  const [draft, setDraft] = useState('');

  if (!doc) return null;
  const mine = docTerms(doc);
  const added = new Set((doc.termsAdded ?? []).map((t) => t.toLowerCase()));

  const remove = (t: string) => {
    const k = t.toLowerCase();
    db.docs.update(doc.id, {
      termsAdded: (doc.termsAdded ?? []).filter((x) => x.toLowerCase() !== k),
      termsRemoved: added.has(k) ? doc.termsRemoved : [...new Set([...(doc.termsRemoved ?? []), t])],
    });
  };
  const add = () => {
    const terms = draft.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
    if (!terms.length) return;
    const lower = new Set(terms.map((t) => t.toLowerCase()));
    db.docs.update(doc.id, {
      termsAdded: [...new Set([...(doc.termsAdded ?? []), ...terms])],
      termsRemoved: (doc.termsRemoved ?? []).filter((t) => !lower.has(t.toLowerCase())),
    });
    setDraft('');
  };

  return (
    <div className="terms">
      <section>
        <h4>이 PDF의 용어 <span className="muted">{mine.length}개</span></h4>
        <p className="muted">PDF에서 자동으로 찾았어요. 잘못된 건 ✕로 빼고, 빠진 용어(한국어 포함)는 직접 추가하세요.</p>
        <div className="chips">
          {mine.map((t) => (
            <span key={t} className={`chip ${added.has(t.toLowerCase()) ? 'mine' : ''}`}>
              {t}
              <button aria-label={`${t} 빼기`} onClick={() => remove(t)}>✕</button>
            </span>
          ))}
          {!mine.length && <span className="muted">아직 없어요. PDF를 열면 잠시 뒤 채워져요.</span>}
        </div>
        <div className="row-wrap">
          <input
            className="text-input"
            value={draft}
            placeholder="용어 추가 (쉼표로 여러 개)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button onClick={add} disabled={!draft.trim()}>추가</button>
        </div>
      </section>

      <section>
        <h4>폴더 용어 <span className="muted">{course ? course.name : '폴더 없음'}</span></h4>
        {course ? (
          <div className="chips">
            {course.vocab.map((t) => <span key={t} className="chip folder">{t}</span>)}
            {!course.vocab.length && <span className="muted">없어요. 문서 목록의 ⚙ 과목 설정에서 넣을 수 있어요.</span>}
          </div>
        ) : (
          <p className="muted">이 PDF는 폴더에 없어요. 문서 목록에서 과목 폴더로 옮기면 폴더 용어와 같은 폴더 PDF의 용어도 함께 쓰여요.</p>
        )}
      </section>

      <section>
        <h4>실제로 쓰는 목록 <span className="muted">{used?.length ?? 0}개 · 자막·번역·요약</span></h4>
        <p className="muted">폴더 용어 → 이 PDF 용어 → 같은 폴더 다른 PDF 용어 순서로, 최대 100개까지 써요.</p>
        <div className="chips">{used?.map((t) => <span key={t} className="chip used">{t}</span>)}</div>
      </section>
    </div>
  );
}
