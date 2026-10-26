import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSummaryPrompt, shareQuestion } from '../ask';
import { db, type Segment } from '../db';
import { loadSettings } from '../llm';
import Markdown from './Markdown';
import Questions from './Questions';
import TermsPanel from './TermsPanel';
import { isNative } from '../native';
import { currentPdf } from '../pdf';
import { pdfAllText } from '../terms';
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
  const pageOrder = useStore((s) => s.pageOrder);
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
          <span>p.{pageOrder.indexOf(g.page) + 1 || g.page}</span>
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

/** Send the whole lecture transcript (+ course info and PDF text) to Claude / ChatGPT for a summary. */
function SummaryButton({ recId, lines, korean }: { recId: string; lines: Segment[]; korean: boolean }) {
  const course = useStore((s) => s.course);
  const docId = useStore((s) => s.docId);
  const recordings = useStore((s) => s.recordings);
  const saveQuestion = useStore((s) => s.saveQuestion);
  const [status, setStatus] = useState<string | null>(null);

  const run = async () => {
    setStatus('준비 중…');
    try {
      const doc = docId ? await db.docs.get(docId) : undefined;
      const pdfText = currentPdf.doc ? await pdfAllText(currentPdf.doc, 30) : '';
      const prompt = buildSummaryPrompt({ captions: lines, docName: doc?.name ?? '', korean, course, pdfText });
      const n = recordings.findIndex((r) => r.id === recId) + 1;
      await saveQuestion({ prompt, label: `수업 요약 (녹음 ${n})`, recId, t: 0 });
      await shareQuestion(prompt);
      setStatus('공유했어요. 받은 요약은 "AI 질문" 탭에 붙여넣어 둘 수 있어요.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(/cancel/i.test(msg) ? null : msg);
    }
  };

  return (
    <div className="summary-row">
      <button onClick={run}>📝 수업 요약 → Claude / ChatGPT</button>
      {status && <div className="muted">{status}</div>}
    </div>
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
  const importRecording = useStore((s) => s.importRecording);
  const deleteRecording = useStore((s) => s.deleteRecording);
  const retranscribe = useStore((s) => s.retranscribe);
  const importing = useStore((s) => s.importing);
  const translateAll = useStore((s) => s.translateAll);
  const translatingAll = useStore((s) => s.translatingAll);
  const refineAll = useStore((s) => s.refineAll);
  const refining = useStore((s) => s.refining);
  const [chosen, setChosen] = useState<string | null>(null);
  const [showKo, setShowKo] = useState(true);
  const [now, setNow] = useState(-1);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  const recId = activeRec?.id ?? chosen ?? playingRecId ?? recordings.at(-1)?.id ?? null;
  const lines = useMemo(() => segments.filter((s) => s.recId === recId), [segments, recId]);
  const korean = recordings.find((r) => r.id === recId)?.lang === 'ko-KR';

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
              녹음 {i + 1}{r.name ? ` (${r.name})` : ''} · {new Date(r.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {r.id === activeRec?.id ? ' (녹음 중)' : ''}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={showKo} onChange={(e) => setShowKo(e.target.checked)} /> 번역
        </label>
        {recId && recId !== activeRec?.id && (
          <button
            className="danger"
            title="이 녹음 삭제"
            onClick={() => {
              const n = recordings.findIndex((r) => r.id === recId) + 1;
              if (confirm(`녹음 ${n}을(를) 삭제할까요?\n오디오·자막·번역·요약이 함께 지워져요. 그때 쓴 필기는 남아요.`)) {
                setChosen(null);
                deleteRecording(recId);
              }
            }}
          >
            🗑
          </button>
        )}
        {isNative && recId && recId !== activeRec?.id && !importing && (
          <button
            title="이 녹음의 자막을 다른 언어로 다시 받기"
            onClick={() => {
              const to = korean ? 'en-US' : 'ko-KR';
              const label = to === 'ko-KR' ? '한국어' : '영어';
              if (confirm(`이 녹음을 ${label} 강의로 보고 자막을 다시 만들까요?\n지금 자막·번역·요약은 새 것으로 바뀌어요.`)) retranscribe(recId, to);
            }}
          >
            {korean ? '영어로 다시' : '한국어로 다시'}
          </button>
        )}
        {isNative && (
          <button
            title="다른 앱에서 내보낸 녹음 파일 가져오기"
            disabled={Boolean(activeRec || importing)}
            onClick={() => importRecording().catch((e) => alert(e instanceof Error ? e.message : String(e)))}
          >
            📂
          </button>
        )}
      </div>
      {showKo && !korean && recId && !activeRec && !importing && lines.some((l) => l.ko2 === undefined) && (
        <div className="hint">
          {refining
            ? `AI가 번역을 다듬는 중… ${refining.done} / ${refining.total}줄`
            : <>AI로 다듬지 않은 줄 {lines.filter((l) => l.ko2 === undefined).length}개{' '}
                <button className="link small" onClick={() => refineAll(recId)}>AI로 다듬기</button></>}
        </div>
      )}
      {isNative && showKo && !korean && recId && !activeRec && !importing && !loadSettings().refine && lines.some((l) => !l.ko) && (
        <div className="hint">
          번역 안 된 줄 {lines.filter((l) => !l.ko).length}개{' '}
          <button className="link small" disabled={translatingAll} onClick={() => translateAll(recId)}>
            {translatingAll ? '번역 중…' : '모두 번역'}
          </button>
        </div>
      )}
      {importing && (
        <div className="hint">
          녹음 파일 자막 만드는 중… {fmtTime(importing.seconds)} / {fmtTime(importing.duration)}
        </div>
      )}
      {lines.length > 0 && recId && <SummaryButton recId={recId} lines={lines} korean={korean} />}
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
          <li key={l.id} className={`${now >= l.start && now < l.end + 0.5 ? 'current' : ''} ${l.ko2 === '' ? 'filler' : ''}`}>
            <button className="ts" onClick={() => playAt(l.recId, l.start)} disabled={l.recId === activeRec?.id}>
              {fmtTime(l.start)}
            </button>
            <div className="line-body">
              <div className="en">{l.text}</div>
              {showKo && !korean &&
                (l.ko2 !== undefined
                  ? l.ko2 && <div className="ko ai">{l.ko2}</div>
                  : l.ko
                    ? <div className="ko">{l.ko}</div>
                    : isNative && <button className="link small" onClick={() => translateSegment(l.id)}>번역</button>)}
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

function LectureSummary() {
  const recordings = useStore((s) => s.recordings);
  const summaries = useStore((s) => s.summaries);
  const summarizing = useStore((s) => s.summarizing);
  const activeRec = useStore((s) => s.activeRec);
  const summarizeRec = useStore((s) => s.summarizeRec);
  const summarizeRange = useStore((s) => s.summarizeRange);
  const captionError = useStore((s) => s.captionError);
  const hasLines = useStore((s) => s.segments);
  const pageCount = useStore((s) => s.pageOrder.length);
  const pagePos = useStore((s) => s.pageOrder.indexOf(s.viewPage) + 1);
  const finished = recordings.filter((r) => r.id !== activeRec?.id);
  const ranges = summaries.filter((x) => x.recId.startsWith('range:')).sort((a, b) => a.createdAt - b.createdAt);
  const [chosen, setChosen] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const recId = chosen ?? finished.at(-1)?.id ?? ranges.at(-1)?.recId ?? null;
  const sum = summaries.find((x) => x.recId === recId);
  const isRange = recId?.startsWith('range:');
  const canRun = recId && !isRange && hasLines.some((s) => s.recId === recId) && !summarizing;

  const lo = Math.max(1, Math.min(pageCount, Number(from) || pagePos || 1));
  const hi = Math.max(lo, Math.min(pageCount, Number(to) || lo));
  const runRange = async () => {
    const id = await summarizeRange(lo, hi);
    if (id) setChosen(id);
  };

  return (
    <div className="transcript">
      <div className="transcript-bar">
        <select value={recId ?? ''} onChange={(e) => setChosen(e.target.value || null)}>
          {!finished.length && !ranges.length && <option value="">요약 없음</option>}
          {finished.map((r, i) => (
            <option key={r.id} value={r.id}>
              녹음 {i + 1}{r.name ? ` (${r.name})` : ''} · {new Date(r.startedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </option>
          ))}
          {ranges.map((x) => (
            <option key={x.recId} value={x.recId}>페이지 {x.recId.split(':')[2].replace('-', '~')}쪽</option>
          ))}
        </select>
        {!isRange && <button disabled={!canRun} onClick={() => recId && summarizeRec(recId)}>{sum ? '다시 만들기' : '요약 만들기'}</button>}
      </div>
      <div className="range-bar">
        <span>페이지</span>
        <input type="number" inputMode="numeric" min={1} max={pageCount} placeholder={String(pagePos || 1)} value={from} onChange={(e) => setFrom(e.target.value)} />
        <span>~</span>
        <input type="number" inputMode="numeric" min={1} max={pageCount} placeholder={String(lo)} value={to} onChange={(e) => setTo(e.target.value)} />
        <button disabled={Boolean(summarizing) || !pageCount} onClick={runRange}>범위 요약</button>
      </div>
      <div className="hint small">그 페이지들의 내용과, 녹음 중 그 페이지를 보고 있을 때 나온 강의 내용을 함께 요약해요.</div>
      {summarizing?.recId === recId && <div className="hint">{summarizing.msg}</div>}
      {captionError && !summarizing && <div className="warn">{captionError}</div>}
      {sum ? (
        <div className="summary">
          <Markdown text={sum.text} />
          <div className="muted">{new Date(sum.createdAt).toLocaleString('ko-KR')}에 만듦</div>
        </div>
      ) : (
        !summarizing && (
          <div className="hint">
            {finished.length ? '아직 요약이 없어요. 요약 만들기를 누르세요.' : '녹음을 마치면 강의 요약이 여기에 만들어져요. 페이지 범위를 정해서 요약할 수도 있어요.'}
          </div>
        )
      )}
    </div>
  );
}

function audioRecIdMatches(recId: string | null) {
  return Boolean(recId) && useStore.getState().playingRecId === recId;
}

export default function SidePanel() {
  const setSideOpen = useStore((s) => s.setSideOpen);
  const tab = useStore((s) => s.sidePanelTab);
  const setTab = useStore((s) => s.setSidePanelTab);
  const qCount = useStore((s) => s.questions.length);
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>자막·번역</button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>요약</button>
        <button className={tab === 'order' ? 'active' : ''} onClick={() => setTab('order')}>필기 순서</button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 질문{qCount ? ` ${qCount}` : ''}</button>
        <button className={tab === 'terms' ? 'active' : ''} onClick={() => setTab('terms')}>용어</button>
        <button className="panel-close" onClick={() => setSideOpen(false)} title="패널 닫기" aria-label="패널 닫기">▸</button>
      </div>
      {tab === 'transcript' && <Transcript />}
      {tab === 'summary' && <LectureSummary />}
      {tab === 'order' && (
        <>
          <Player />
          <div className="hint">항목을 누르면 해당 필기로 이동하고 그때 녹음이 재생돼요. 페이지에서 필기를 손가락으로 탭해도 재생돼요.</div>
          <Timeline />
        </>
      )}
      {tab === 'ai' && <Questions />}
      {tab === 'terms' && <TermsPanel />}
    </aside>
  );
}
