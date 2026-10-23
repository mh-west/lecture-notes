import { useEffect, useState } from 'react';
import { fmtTime } from '../ink';
import { useStore, type Tool } from '../store';

const COLORS = ['#1f2937', '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#f59e0b'];
const SIZES = [1.4, 2.2, 3.5];

function RecButton() {
  const activeRec = useStore((s) => s.activeRec);
  const start = useStore((s) => s.startRecording);
  const stop = useStore((s) => s.stopRecording);
  const [, tick] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeRec) return;
    const i = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(i);
  }, [activeRec]);

  if (activeRec) {
    return (
      <button className="rec on" onClick={stop}>
        <span className="dot" /> {fmtTime(useStore.getState().recTime() ?? 0)} 정지
      </button>
    );
  }
  return (
    <button
      className="rec"
      title={err ?? '녹음 시작'}
      onClick={() => start().then(() => setErr(null), (e) => setErr(String(e)))}
    >
      <span className="dot" /> 녹음{err ? ' (마이크 권한 확인)' : ''}
    </button>
  );
}

export default function Toolbar({ onBack, title }: { onBack: () => void; title: string }) {
  const { tool, color, size, zoom, fingerDraw, showOrder, undoStack, redoStack } = useStore();
  const { setTool, setColor, setSize, setZoom, setFingerDraw, setShowOrder, undo, redo } = useStore();

  const toolBtn = (t: Tool, label: string, disabled = false) => (
    <button className={tool === t ? 'active' : ''} onClick={() => setTool(t)} disabled={disabled}>
      {label}
    </button>
  );

  return (
    <div className="toolbar">
      <button onClick={onBack} title="문서 목록">‹</button>
      <span className="title">{title}</span>
      <div className="sep" />
      {toolBtn('pen', '✏️ 펜')}
      {toolBtn('highlighter', '🖍 형광')}
      {toolBtn('eraser', '🧽 지우개')}
      <button disabled title="3단계에서 추가: 동그라미 쳐서 AI에 질문">⭕ AI</button>
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
        ☝️
      </button>
      <button className={showOrder ? 'active' : ''} onClick={() => setShowOrder(!showOrder)} title="필기 순서 번호 표시">
        ①②
      </button>
      <div className="grow" />
      <RecButton />
    </div>
  );
}
