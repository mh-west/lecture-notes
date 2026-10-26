import { useEffect, useState } from 'react';
import type { Question } from '../db';
import { fmtTime } from '../ink';
import { useStore } from '../store';
import Markdown from './Markdown';

function BlobImage({ blob, onClick }: { blob: Blob; onClick: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" onClick={onClick} /> : null;
}

/** The recall card: what was asked, the key idea, the skeleton, what to watch out for. */
function Card({ q, hideAnswer = false }: { q: Question; hideAnswer?: boolean }) {
  const c = q.card!;
  const text = [
    `**질문** ${c.question || q.label}`,
    ...(hideAnswer
      ? []
      : [
          `**핵심** ${c.gist}`,
          ...(c.steps.length ? ['**뼈대**', ...c.steps.map((s, i) => `- ${i + 1}. ${s}`)] : []),
          ...(c.pitfalls ? [`**주의** ${c.pitfalls}`] : []),
        ]),
  ].join('\n');
  return (
    <div className="memory-card">
      <Markdown text={text} />
    </div>
  );
}

function Where({ q }: { q: Question }) {
  const focus = useStore((s) => s.focusStrokes);
  const playAt = useStore((s) => s.playAt);
  return (
    <span className="muted">
      {q.page ? (
        <button className="link small" onClick={() => q.bounds && focus(q.page!, q.bounds.minY, [])}>p.{q.page}</button>
      ) : (
        '자막'
      )}
      {q.t != null && q.recId && (
        <>
          {' · '}
          <button className="link small" onClick={() => playAt(q.recId!, q.t!).catch(() => {})}>▶ {fmtTime(q.t)}</button>
        </>
      )}
      {' · '}
      {new Date(q.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
    </span>
  );
}

/** One due card at a time: try to recall, then reveal and say whether it came back. */
function Review({ onDone }: { onDone: () => void }) {
  const questions = useStore((s) => s.questions);
  const reviewCard = useStore((s) => s.reviewCard);
  const [due] = useState(() => questions.filter((q) => q.card && (q.review?.due ?? 0) <= Date.now()).map((q) => q.id));
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const q = questions.find((x) => x.id === due[i]);

  if (!q) {
    return (
      <div className="review">
        <p className="hint">{due.length ? `복습 끝! 카드 ${due.length}개를 봤어요.` : '지금 복습할 카드가 없어요.'}</p>
        <button onClick={onDone}>목록으로</button>
      </div>
    );
  }
  const next = (remembered: boolean) => {
    reviewCard(q.id, remembered);
    setShown(false);
    setI(i + 1);
  };
  return (
    <div className="review">
      <div className="review-head">
        <span className="muted">복습 {i + 1} / {due.length}</span>
        <button className="link small" onClick={onDone}>그만하기</button>
      </div>
      {q.image && <BlobImage blob={q.image} onClick={() => {}} />}
      <Card q={q} hideAnswer={!shown} />
      <Where q={q} />
      {!shown ? (
        <button className="primary big" onClick={() => setShown(true)}>떠올려 보고 → 뼈대 보기</button>
      ) : (
        <div className="row-wrap">
          <button className="big" onClick={() => next(false)}>헷갈려</button>
          <button className="primary big" onClick={() => next(true)}>기억났어</button>
        </div>
      )}
    </div>
  );
}

export default function Questions() {
  const questions = useStore((s) => s.questions);
  const update = useStore((s) => s.updateQuestion);
  const remove = useStore((s) => s.deleteQuestion);
  const focus = useStore((s) => s.focusStrokes);
  const openAsk = useStore((s) => s.openAsk);
  const makeCard = useStore((s) => s.makeCard);
  const busy = useStore((s) => s.cardBusy);
  const [reviewing, setReviewing] = useState(false);

  if (!questions.length) {
    return <div className="hint">툴바의 ⭕ 질문 도구로 PDF에서 모르는 부분을 동그라미 치거나, 자막 옆 ? 버튼을 누르면 Claude / ChatGPT로 바로 물어볼 수 있어요. 받은 답을 붙여넣으면 다시 봤을 때 떠오르게 짧은 기억 카드로 정리해 줘요.</div>;
  }
  if (reviewing) return <Review onDone={() => setReviewing(false)} />;

  const dueCount = questions.filter((q) => q.card && (q.review?.due ?? 0) <= Date.now()).length;
  return (
    <div className="questions-wrap">
      <div className="review-bar">
        <span className="muted">카드 {questions.filter((q) => q.card).length}개</span>
        <button className={dueCount ? 'primary' : ''} disabled={!dueCount} onClick={() => setReviewing(true)}>
          복습 {dueCount}개
        </button>
      </div>
      <ol className="questions">
        {[...questions].reverse().map((q) => (
          <li key={q.id}>
            {q.image && <BlobImage blob={q.image} onClick={() => q.page && q.bounds && focus(q.page, q.bounds.minY, [])} />}
            <div className="q-meta">
              <b>{q.label}</b>
              <Where q={q} />
            </div>
            {q.card && <Card q={q} />}
            {busy.includes(q.id) && <div className="hint">기억 카드 만드는 중…</div>}
            {q.card ? (
              <details>
                <summary className="muted">받은 답 전체 보기</summary>
                <textarea
                  defaultValue={q.answer}
                  rows={8}
                  onBlur={(e) => e.target.value !== (q.answer ?? '') && update(q.id, { answer: e.target.value })}
                />
              </details>
            ) : (
              <textarea
                placeholder="받은 답을 여기에 붙여넣으면 다시 봤을 때 떠오르게 짧은 기억 카드로 정리해 줘요"
                defaultValue={q.answer}
                rows={q.answer ? 5 : 2}
                onBlur={(e) => e.target.value !== (q.answer ?? '') && update(q.id, { answer: e.target.value })}
              />
            )}
            <div className="row-wrap">
              {q.answer?.trim() && !busy.includes(q.id) && (
                <button onClick={() => makeCard(q.id)}>{q.card ? '카드 다시 만들기' : '기억 카드 만들기'}</button>
              )}
              {q.page && q.bounds && <button onClick={() => openAsk({ page: q.page, bounds: q.bounds, recId: q.recId, t: q.t })}>다시 묻기</button>}
              <button className="danger" onClick={() => confirm('이 질문을 삭제할까요?') && remove(q.id)}>삭제</button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
