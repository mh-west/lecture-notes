import { useEffect, useState } from 'react';
import { fmtTime } from '../ink';
import { useStore, type Tool } from '../store';
import AiSettings from './AiSettings';

const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#f59e0b'];
const SIZES = [1.4, 2.2, 3.5];

function LangToggle() {
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const recording = useStore((s) => Boolean(s.activeRec));
  return (
    <div className="seg" title="강의 언어 (자막 인식 언어)">
      <button className={lang === 'en-US' ? 'active' : ''} disabled={recording} onClick={() => setLang('en-US')}>EN</button>
      <button className={lang === 'ko-KR' ? 'active' : ''} disabled={recording} onClick={() => setLang('ko-KR')}>한</button>
    </div>
  );
}

function RecButton() {
  const activeRec = useStore((s) => s.activeRec);
  const start = useStore((s) => s.startRecording);
  const stop = useStore((s) => s.stopRecording);
  const [, tick] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); // starting: the mic and permissions can take a moment

  const onStart = () => {
    if (busy) return;
    setBusy(true);
    start()
      .then(
        () => setErr(null),
        (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('startRecording failed:', msg);
          setErr(msg);
          alert(`녹음을 시작하지 못했어요\n\n${msg}`);
        },
      )
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    if (!activeRec) return;
    const i = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(i);
  }, [activeRec]);

  if (activeRec) {
    return (
      <button
        className="rec on"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          stop().finally(() => setBusy(false));
        }}
      >
        <span className="dot" /> {busy ? '저장 중…' : `${fmtTime(useStore.getState().recTime() ?? 0)} 정지`}
      </button>
    );
  }
  return (
    <button className="rec" title={err ?? '녹음 시작'} onClick={onStart} disabled={busy}>
      <span className="dot" /> {busy ? '준비 중…' : `녹음${err ? ' (오류)' : ''}`}
    </button>
  );
}

export default function Toolbar({ onBack, title }: { onBack: () => void; title: string }) {
  const { tool, color, size, zoom, fingerDraw, showOrder, overview, undoStack, redoStack } = useStore();
  const { setTool, setColor, setSize, setZoom, setFingerDraw, setShowOrder, setOverview, undo, redo } = useStore();
  const [showSettings, setShowSettings] = useState(false);
  const addBlankPage = useStore((s) => s.addBlankPage);

  const toolBtn = (t: Tool, label: string) => (
    <button className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>
      {label}
    </button>
  );

  return (
    <div className="toolbar">
      <button onClick={onBack} title="문서 목록">‹</button>
      <button className={overview ? 'active' : ''} onClick={() => setOverview(!overview)} title="전체 페이지 보기">
        ▦
      </button>
      <button onClick={addBlankPage} title="지금 페이지 뒤에 빈 페이지 추가">＋ 빈 페이지</button>
      <span className="title">{title}</span>
      <div className="sep" />
      {toolBtn('pen', '✏️ 펜')}
      {toolBtn('highlighter', '🖍 형광')}
      {toolBtn('eraser', '🧽 지우개')}
      {toolBtn('lasso', '⭕ 질문')}
      <div className="sep" />
      {COLORS.map((c) => (
        <button
          key={c}
          className={`swatch ${color === c && tool !== 'eraser' ? 'active' : ''}`}
          style={{ background: c }}
          onClick={() => setColor(c)}
          aria-label={c}
        />
      ))}
      {SIZES.map((s) => (
        <button key={s} className={size === s ? 'active' : ''} onClick={() => setSize(s)} title="굵기">
          <span className="size-dot" style={{ width: s * 3, height: s * 3 }} />
        </button>
      ))}
      <div className="sep" />
      <button onClick={undo} disabled={!undoStack.length}>↶</button>
      <button onClick={redo} disabled={!redoStack.length}>↷</button>
      <button onClick={() => setZoom(Math.max(0.6, +(zoom - 0.2).toFixed(1)))}>−</button>
      <span className="zoom">{Math.round(zoom * 100)}%</span>
      <button onClick={() => setZoom(Math.min(3, +(zoom + 0.2).toFixed(1)))}>+</button>
      <button className={fingerDraw ? 'active' : ''} onClick={() => setFingerDraw(!fingerDraw)} title="손가락으로도 필기">
        ☝️ 손필기
      </button>
      <button className={showOrder ? 'active' : ''} onClick={() => setShowOrder(!showOrder)} title="필기 순서 번호 표시">
        ①② 순서
      </button>
      <div className="grow" />
      <button onClick={() => setShowSettings(true)} title="AI 번역·요약 설정">✨ AI</button>
      <LangToggle />
      <RecButton />
      {showSettings && <AiSettings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
