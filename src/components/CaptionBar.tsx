import { useState } from 'react';
import { useStore } from '../store';

/** Slim live subtitle strip shown over the page while the side panel is closed and a lecture is recording. */
export default function CaptionBar() {
  const activeRec = useStore((s) => s.activeRec);
  const partial = useStore((s) => s.partial);
  const last = useStore((s) => s.segments.filter((x) => x.recId === s.activeRec?.id).at(-1));
  const setSideOpen = useStore((s) => s.setSideOpen);
  const [hidden, setHidden] = useState(false);

  if (!activeRec || hidden || (!last && !partial)) return null;
  return (
    <div className="caption-bar">
      <div className="caption-text" onClick={() => setSideOpen(true)}>
        {partial ? <div className="en partial">{partial}</div> : <div className="en">{last?.text}</div>}
        {!partial && last?.ko && <div className="ko">{last.ko}</div>}
      </div>
      <button onClick={() => setHidden(true)} aria-label="자막 숨기기">✕</button>
    </div>
  );
}
