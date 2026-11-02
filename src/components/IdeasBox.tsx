import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { copyText, shareQuestion } from '../ask';
import { db, uid } from '../db';

const OPEN_KEY = 'ideasOpen';

/** Wish list for the app itself, kept on the iPad and sent to Claude in one go when it's time to build. */
export default function IdeasBox() {
  const ideas = useLiveQuery(() => db.ideas.orderBy('createdAt').toArray(), []);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [status, setStatus] = useState<string | null>(null);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? '0' : '1');
    } catch {
      /* not remembered */
    }
  };

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    await db.ideas.put({ id: uid(), text: t, createdAt: Date.now() });
    setText('');
  };

  const pending = (ideas ?? []).filter((i) => !i.done);
  const asPrompt = () =>
    `강의노트 앱(github.com/mh-west/lecture-notes)에 추가하고 싶은 기능이야. 하나씩 구현해줘:\n\n${pending
      .map((i, n) => `${n + 1}. ${i.text}`)
      .join('\n')}`;

  const send = async (how: 'copy' | 'share') => {
    try {
      if (how === 'copy') await copyText(asPrompt());
      else await shareQuestion(asPrompt());
      setStatus(how === 'copy' ? '복사했어요. Claude에게 붙여넣으세요.' : null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) setStatus(msg);
    }
  };

  return (
    <section className="ideas">
      <button className="ideas-head" onClick={toggle}>
        <span>💡 추가하고 싶은 기능 메모</span>
        <span className="muted">{pending.length ? `${pending.length}개` : ''} {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <div className="ideas-input">
            <textarea
              rows={2}
              value={text}
              placeholder="쓰다가 생각난 기능을 적어두세요 (예: 필기 색 더 많이, 녹음 중 북마크)"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button className="primary" onClick={add} disabled={!text.trim()}>추가</button>
          </div>
          {!!ideas?.length && (
            <ul className="ideas-list">
              {ideas.map((i) => (
                <li key={i.id} className={i.done ? 'done' : ''}>
                  <input
                    type="checkbox"
                    checked={Boolean(i.done)}
                    onChange={(e) => db.ideas.update(i.id, { done: e.target.checked })}
                    aria-label="완료"
                  />
                  <span className="idea-text">{i.text}</span>
                  <span className="muted">{new Date(i.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</span>
                  <button className="danger small-btn" onClick={() => db.ideas.delete(i.id)} aria-label="삭제">✕</button>
                </li>
              ))}
            </ul>
          )}
          {pending.length > 0 && (
            <div className="row-wrap">
              <button onClick={() => send('copy')}>📋 Claude에게 보낼 글로 복사</button>
              <button onClick={() => send('share')}>공유…</button>
            </div>
          )}
          {status && <div className="muted">{status}</div>}
        </>
      )}
    </section>
  );
}
