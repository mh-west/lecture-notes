import { useEffect, useMemo, useRef, useState } from 'react';
import { isNative } from '../native';
import { fmtTime, groupStrokes } from '../ink';
import { audio, useStore } from '../store';

function Player() {
  const recordings = useStore((s) => s.recordings);
  const playingRecId = useStore((s) => s.playingRecId);
  const replayT = useStore((s) => s.replayT);
  const setReplayT = useStore((s) => s.setReplayT);
  const playAt = useStore((s) => s.playAt);
  const activeRec = useStore((s) => s.activeRec);
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(0);
  const [paused, setPaused] = useState(true);
  const [follow, setFollow] = useState(false);

  useEffect(() => {
    const on = () => {
      setNow(audio.currentTime);
      setDur(Number.isFinite(audio.duration) ? audio.duration : 0);
      setPaused(audio.paused);
    };
    const evs = ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange'];
    evs.forEach((e) => audio.addEventListener(e, on));
    return () => evs.forEach((e) => audio.removeEventListener(e, on));
  }, []);

  // "필기 재생": show only what was written up to the current audio position.
  useEffect(() => {
    if (follow) setReplayT(now);
  }, [follow, now, setReplayT]);
  useEffect(() => {
    if (!follow) setReplayT(null);
  }, [follow, setReplayT]);

  const finished = recordings.filter((r) => r.id !== activeRec?.id);
  if (!finished.length) return <div className="hint">녹음을 시작하면 필기 하나하나에 강의 시간이 기록돼요.</div>;

  const playing = finished.find((r) => r.id === playingRecId);
  // Chrome's webm recordings report duration=Infinity; fall back to wall-clock length.
  const total = dur || (playing?.endedAt ? (playing.endedAt - playing.startedAt) / 1000 : 0);
  return (
    <div className="player">
      <select
        value={playingRecId ?? ''}
        onChange={(e) => e.target.value && playAt(e.target.value, 0)}
      >
        <option value="">녹음 선택…</option>
        {finished.map((r, i) => (
          <option key={r.id} value={r.id}>
            {i + 1}. {new Date(r.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </option>
        ))}
      </select>
      {playing && (
        <>
          <div className="row">
            <button onClick={() => (audio.paused ? audio.play() : audio.pause())}>{paused ? '▶' : '❚❚'}</button>
            <button onClick={() => (audio.currentTime = Math.max(0, audio.currentTime - 10))}>-10s</button>
            <button onClick={() => (audio.currentTime += 10)}>+10s</button>
            <select defaultValue="1" onChange={(e) => (audio.playbackRate = +e.target.value)}>
              {[0.75, 1, 1.25, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
            </select>
            <span className="time">{fmtTime(now)} / {fmtTime(total)}</span>
          </div>
          <input
            type="range" min={0} max={total || 1} step={0.5} value={now}
            onChange={(e) => (audio.currentTime = +e.target.value)}
          />
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            필기 재생 (재생 위치까지 쓴 필기만 보기)
          </label>
          {replayT != null && <div className="hint">필기 재생 중 — 체크를 풀면 전체 필기가 다시 보여요.</div>}
        </>
      )}
    </div>
  );
}

function Timeline() {
  const strokes = useStore((s) => s.strokes);
  const recordings = useStore((s) => s.recordings);
  const playAt = useStore((s) => s.playAt);
  const focusStrokes = useStore((s) => s.focusStrokes);
  const groups = useMemo(() => groupStrokes(strokes), [strokes]);
  const recIndex = new Map(recordings.map((r, i) => [r.id, i + 1]));

  if (!groups.length) return <div className="hint">아직 필기가 없어요.</div>;
  return (
    <ol className="timeline">
      {[...groups].reverse().map((g) => (
        <li
          key={g.index}
          onClick={() => {
            focusStrokes(g.page, g.bounds.minY, g.strokeIds);
            if (g.recId && g.t != null) playAt(g.recId, g.t).catch(() => {});
          }}
        >
          <span className="num">{g.index}</span>
          <span>p.{g.page}</span>
          <span className="muted">
            {g.recId && g.t != null
              ? `녹음${recIndex.get(g.recId) ?? ''} ${fmtTime(g.t)}`
              : new Date(g.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span className="muted">{g.strokeIds.length}획</span>
        </li>
      ))}
    </ol>
  );
}

function Transcript() {
  const segments = useStore((s) => s.segments);
  const recordings = useStore((s) => s.recordings);
  const activeRec = useStore((s) => s.activeRec);
  const playingRecId = useStore((s) => s.playingRecId);
  const partial = useStore((s) => s.partial);
  const captionError = useStore((s) => s.captionError);
  const playAt = useStore((s) => s.playAt);
  const openAsk = useStore((s) => s.openAsk);
  const translateSegment = useStore((s) => s.translateSegment);
  const [chosen, setChosen] = useState<string | null>(null);
  const [showKo, setShowKo] = useState(true);
  const [now, setNow] = useState(-1);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  const recId = activeRec?.id ?? chosen ?? playingRecId ?? recordings.at(-1)?.id ?? null;
  const lines = useMemo(() => segments.filter((s) => s.recId === recId), [segments, recId]);

  useEffect(() => {
    const on = () => setNow(audioRecIdMatches(recId) ? audio.currentTime : -1);
    audio.addEventListener('timeupdate', on);
    return () => audio.removeEventListener('timeupdate', on);
  }, [recId]);

  // Follow new captions unless the user scrolled up to read something.
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, partial]);

  return (
    <div className="transcript">
      <div className="transcript-bar">
        <select value={recId ?? ''} onChange={(e) => setChosen(e.target.value || null)} disabled={Boolean(activeRec)}>
          {!recordings.length && <option value="">녹음 없음</option>}
          {recordings.map((r, i) => (
            <option key={r.id} value={r.id}>
              녹음 {i + 1} · {new Date(r.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {r.id === activeRec?.id ? ' (녹음 중)' : ''}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={showKo} onChange={(e) => setShowKo(e.target.checked)} /> 번역
        </label>
      </div>
      {captionError && <div className="warn">{captionError}</div>}
      {!lines.length && !partial && (
        <div className="hint">
          {activeRec ? '듣고 있어요… 교수님이 말하면 여기에 자막이 나와요.' : '녹음을 시작하면 영어 자막과 한국어 번역이 실시간으로 표시돼요.'}
          {!isNative && ' (브라우저에서는 번역 없이 자막만 지원)'}
        </div>
      )}
      <ol
        className="lines"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.map((l) => (
          <li key={l.id} className={now >= l.start && now < l.end + 0.5 ? 'current' : ''}>
            <button className="ts" onClick={() => playAt(l.recId, l.start)} disabled={l.recId === activeRec?.id}>
              {fmtTime(l.start)}
            </button>
            <div className="line-body">
              <div className="en">{l.text}</div>
              {showKo && (l.ko ? <div className="ko">{l.ko}</div> : isNative && <button className="link small" onClick={() => translateSegment(l.id)}>번역</button>)}
            </div>
            <button className="ask-btn" title="이 문장 AI에게 묻기" onClick={() => openAsk({ segment: l })}>?</button>
          </li>
        ))}
        {partial && (
          <li className="partial">
            <span className="ts">…</span>
            <div className="line-body"><div className="en">{partial}</div></div>
          </li>
        )}
      </ol>
    </div>
  );
}

function audioRecIdMatches(recId: string | null) {
  return Boolean(recId) && useStore.getState().playingRecId === recId;
}

function BlobImage({ blob, onClick }: { blob: Blob; onClick: () => void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" onClick={onClick} /> : null;
}

function Questions() {
  const questions = useStore((s) => s.questions);
  const update = useStore((s) => s.updateQuestion);
  const remove = useStore((s) => s.deleteQuestion);
  const focus = useStore((s) => s.focusStrokes);
  const openAsk = useStore((s) => s.openAsk);

  if (!questions.length) {
    return <div className="hint">툴바의 ⭕ 질문 도구로 PDF에서 모르는 부분을 동그라미 치거나, 자막 옆 ? 버튼을 누르면 Claude / ChatGPT로 바로 물어볼 수 있어요.</div>;
  }
  return (
    <ol className="questions">
      {[...questions].reverse().map((q) => (
        <li key={q.id}>
          {q.image && <BlobImage blob={q.image} onClick={() => q.page && q.bounds && focus(q.page, q.bounds.minY, [])} />}
          <div className="q-meta">
            <b>{q.label}</b>
            <span className="muted">
              {q.page ? `p.${q.page}` : '자막'}
              {q.t != null ? ` · ${fmtTime(q.t)}` : ''} · {new Date(q.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <textarea
            placeholder="받은 답을 여기에 붙여넣어 두면 복습할 때 같이 볼 수 있어요"
            defaultValue={q.answer}
            rows={q.answer ? 5 : 2}
            onBlur={(e) => e.target.value !== (q.answer ?? '') && update(q.id, { answer: e.target.value })}
          />
          <div className="row-wrap">
            {q.page && q.bounds && <button onClick={() => openAsk({ page: q.page, bounds: q.bounds, recId: q.recId, t: q.t })}>다시 묻기</button>}
            <button className="danger" onClick={() => confirm('이 질문을 삭제할까요?') && remove(q.id)}>삭제</button>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function SidePanel() {
  const tab = useStore((s) => s.sidePanelTab);
  const setTab = useStore((s) => s.setSidePanelTab);
  const qCount = useStore((s) => s.questions.length);
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>자막·번역</button>
        <button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>필기 순서</button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 질문{qCount ? ` ${qCount}` : ''}</button>
      </div>
      {tab === 'transcript' && <Transcript />}
      {tab === 'order' && (
        <>
          <Player />
          <div className="hint">항목을 누르면 해당 필기로 이동하고 그때 녹음이 재생돼요. 페이지에서 필기를 손가락으로 탭해도 재생돼요.</div>
          <Timeline />
        </>
      )}
      {tab === 'ai' && <Questions />}
    </aside>
  );
}
