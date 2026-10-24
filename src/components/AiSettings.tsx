import { useEffect, useState } from 'react';
import { CLAUDE_MODELS, engineProblem, loadSettings, saveSettings, translateLines, type LlmSettings } from '../llm';

/** Choose the language model used for refined translations and lecture summaries. */
export default function AiSettings({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<LlmSettings>(loadSettings);
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const update = (patch: Partial<LlmSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveSettings(next);
    setStatus(null);
  };

  useEffect(() => {
    engineProblem(s).then((p) => setStatus(p ? `⚠️ ${p}` : '✅ 사용할 수 있어요'));
  }, [s]);

  const test = async () => {
    setTesting(true);
    setStatus('시험 번역 중…');
    try {
      const [ko] = await translateLines(['So, uh, this is a martindale, you know, because the expectation is constant.'], null, []);
      setStatus(`✅ "${ko}"`);
    } catch (e) {
      console.error('[lecture-notes] test translation', e instanceof Error ? `${e.message}\n${e.stack}` : e);
      setStatus(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h2>AI 번역·요약 설정</h2>
          <button onClick={onClose}>닫기</button>
        </header>
        <p className="muted">
          녹음하는 동안 몇 문장마다 보고 있는 페이지와 앞뒤 페이지를 참고해 추임새를 뺀 자연스러운 번역으로 바꾸고,
          녹음이 끝나면 강의 요약을 만들어요.
        </p>
        <label className="check">
          <input type="checkbox" checked={s.refine} onChange={(e) => update({ refine: e.target.checked })} />
          녹음 중 자동으로 번역 다듬기 + 끝나면 요약
        </label>

        <div className="engine-list">
          <label className={`engine ${s.engine === 'apple' ? 'on' : ''}`}>
            <input type="radio" checked={s.engine === 'apple'} onChange={() => update({ engine: 'apple' })} />
            <div>
              <b>기기 내 AI (Apple Intelligence)</b>
              <div className="muted">무료 · 인터넷 없이 동작 · 모델이 작아 번역 품질은 보통</div>
            </div>
          </label>
          <label className={`engine ${s.engine === 'claude' ? 'on' : ''}`}>
            <input type="radio" checked={s.engine === 'claude'} onChange={() => update({ engine: 'claude' })} />
            <div>
              <b>Claude (내 API 키)</b>
              <div className="muted">품질이 가장 좋아요 · 인터넷 필요 · 쓴 만큼 API 요금이 나가요 (구독과 별도)</div>
            </div>
          </label>
        </div>

        {s.engine === 'claude' && (
          <>
            <input
              className="text-input"
              type="password"
              placeholder="sk-ant-… (console.anthropic.com에서 발급)"
              value={s.claudeKey}
              autoComplete="off"
              onChange={(e) => update({ claudeKey: e.target.value })}
            />
            <select value={s.claudeModel} onChange={(e) => update({ claudeModel: e.target.value })}>
              {CLAUDE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <div className="muted">키는 이 iPad 안에만 저장돼요.</div>
          </>
        )}

        <div className="row-wrap">
          <button onClick={test} disabled={testing}>시험 번역</button>
        </div>
        {status && <div className="status">{status}</div>}
      </div>
    </div>
  );
}
