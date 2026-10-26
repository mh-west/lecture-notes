import { useEffect, useMemo, useState } from 'react';
import { buildPrompt, copyImage, copyText, cropPage, dataUrlToBlob, nearbyCaptions, openApp, QUICK_ASKS, shareQuestion } from '../ask';
import { db, type Question } from '../db';
import { fmtTime } from '../ink';
import { pageText } from '../pdf';
import { useStore } from '../store';
import Markdown from './Markdown';

export default function AskDialog() {
  const ask = useStore((s) => s.ask);
  const segments = useStore((s) => s.segments);
  const questions = useStore((s) => s.questions);
  const docId = useStore((s) => s.docId);
  const openAsk = useStore((s) => s.openAsk);
  const saveQuestion = useStore((s) => s.saveQuestion);
  const recordings = useStore((s) => s.recordings);
  const docLang = useStore((s) => s.lang);
  const course = useStore((s) => s.course);

  const [image, setImage] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [preset, setPreset] = useState(0);
  const [question, setQuestion] = useState<string>(QUICK_ASKS[0].text);
  const [docName, setDocName] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!ask) return;
    setStatus(null);
    setSaved(false);
    setShowPrompt(false);
    setImage(ask.page && ask.bounds ? cropPage(ask.page, ask.bounds) : null);
    setText('');
    if (ask.page) pageText(ask.page).then(setText).catch(() => setText(''));
    if (docId) db.docs.get(docId).then((d) => setDocName(d?.name ?? ''));
  }, [ask, docId]);

  const captions = useMemo(() => {
    if (!ask) return [];
    if (ask.segment) return nearbyCaptions(segments, ask.segment.recId, ask.segment.start, 60, 15);
    return nearbyCaptions(segments, ask.recId, ask.t);
  }, [ask, segments]);

  if (!ask) return null;

  // Questions already asked about this spot: same page with an overlapping selection, or the same
  // part of the lecture (within a minute). Seeing the old card first saves asking again.
  const t0 = ask.segment?.start ?? ask.t;
  const rec0 = ask.segment?.recId ?? ask.recId;
  const overlap = (a?: Question['bounds'], b?: Question['bounds']) =>
    Boolean(a && b && a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY);
  const earlier = questions.filter(
    (q) => (ask.page != null && q.page === ask.page && overlap(q.bounds, ask.bounds)) ||
      (!ask.page && rec0 && q.recId === rec0 && q.t != null && t0 != null && Math.abs(q.t - t0) < 60),
  );

  const prompt = buildPrompt({
    question,
    hasImage: Boolean(image),
    captions,
    focusLine: ask.segment?.text,
    pageText: text,
    docName,
    course,
    korean: (recordings.find((r) => r.id === (ask.segment?.recId ?? ask.recId))?.lang ?? docLang) === 'ko-KR',
  });

  const record = async () => {
    if (saved) return;
    setSaved(true);
    await saveQuestion({
      page: ask.page,
      bounds: ask.bounds,
      image: image ? dataUrlToBlob(image) : undefined,
      prompt,
      label: preset >= 0 ? QUICK_ASKS[preset].label : question.slice(0, 40),
      recId: ask.segment?.recId ?? ask.recId,
      t: ask.segment?.start ?? ask.t,
    });
  };

  const run = async (fn: () => Promise<void>, ok: string) => {
    try {
      await record();
      await fn();
      setStatus(ok);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel/i.test(msg)) setStatus(msg);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => openAsk(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>AI에게 질문</h2>
          <button onClick={() => openAsk(null)} aria-label="닫기">✕</button>
        </header>

        {earlier.length > 0 && (
          <div className="earlier">
            <b>이 부분은 전에 {earlier.length}번 물어봤어요</b>
            {earlier.map((q) => (
              <details key={q.id}>
                <summary>
                  <Markdown text={`${q.card?.question || q.label} · ${new Date(q.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}`} />
                </summary>
                {q.card ? (
                  <Markdown text={[`**핵심** ${q.card.gist}`, ...q.card.steps.map((st, i) => `- ${i + 1}. ${st}`), ...(q.card.pitfalls ? [`**주의** ${q.card.pitfalls}`] : [])].join('\n')} />
                ) : (
                  <p className="muted">{q.answer ? `${q.answer.slice(0, 300)}${q.answer.length > 300 ? '…' : ''}` : '답을 아직 붙여넣지 않았어요'}</p>
                )}
              </details>
            ))}
          </div>
        )}
        {image && <img className="ask-image" src={image} alt="선택한 부분" />}
        {ask.segment && <blockquote className="ask-line">“{ask.segment.text}”</blockquote>}
        <div className="muted">
          {captions.length
            ? `교수님 말 ${captions.length}문장 (${fmtTime(captions[0].start)}–${fmtTime(captions.at(-1)!.end)}) 함께 보냄`
            : '함께 보낼 자막 없음 (녹음 중이 아니었거나 자막이 없어요)'}
          {text && ' · 페이지 텍스트 포함'}
        </div>

        <div className="chips">
          {QUICK_ASKS.map((q, i) => (
            <button
              key={q.label}
              className={preset === i ? 'active' : ''}
              onClick={() => {
                setPreset(i);
                setQuestion(q.text);
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
        <textarea
          value={question}
          rows={3}
          onChange={(e) => {
            setPreset(-1);
            setQuestion(e.target.value);
          }}
        />

        <button className="link" onClick={() => setShowPrompt(!showPrompt)}>
          {showPrompt ? '보낼 내용 숨기기' : '보낼 내용 전체 보기'}
        </button>
        {showPrompt && <pre className="prompt-preview">{prompt}</pre>}

        <button className="primary big" onClick={() => run(() => shareQuestion(prompt, image ?? undefined), '보냈어요. 질문 내용은 클립보드에도 복사돼 있어요.')}>
          공유 → Claude / ChatGPT 선택
        </button>
        <div className="row-wrap">
          {image && <button onClick={() => run(() => copyImage(image), '이미지를 복사했어요. 앱에서 붙여넣기 하세요.')}>이미지 복사</button>}
          <button onClick={() => run(() => copyText(prompt), '질문을 복사했어요.')}>질문 복사</button>
          <button onClick={() => run(async () => openApp('claude'), '')}>Claude 열기</button>
          <button onClick={() => run(async () => openApp('chatgpt'), '')}>ChatGPT 열기</button>
        </div>
        {status && <div className="status">{status}</div>}
        <div className="hint">
          팁: Claude 앱을 화면 옆에 띄워두면(Slide Over / Stage Manager) 노트를 보면서 바로 답을 볼 수 있어요. 질문은 "AI 질문" 탭에 저장되고, 받은 답을 붙여넣어 둘 수 있어요.
        </div>
      </div>
    </div>
  );
}
