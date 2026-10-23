import { useEffect, useMemo, useState } from 'react';
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

export default function SidePanel() {
  const [tab, setTab] = useState<'order' | 'transcript' | 'ai'>('order');
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>필기 순서</button>
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>자막·번역</button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 질문</button>
      </div>
      {tab === 'order' && (
        <>
          <Player />
          <div className="hint">항목을 누르면 해당 필기로 이동하고 그때 녹음이 재생돼요. 페이지에서 필기를 손가락으로 탭해도 재생돼요.</div>
          <Timeline />
        </>
      )}
      {tab === 'transcript' && <div className="hint">2단계에서 실시간 영어 자막 + 한국어 번역이 여기에 표시됩니다.</div>}
      {tab === 'ai' && <div className="hint">3단계에서 ⭕ 도구로 동그라미 친 부분의 AI 답변이 여기에 카드로 쌓입니다.</div>}
    </aside>
  );
}
