import { useEffect, useState } from 'react';
import { CLAUDE_MODELS, engineProblem, loadSettings, saveSettings, translateLines, type LlmSettings } from '../llm';
import { isNative, LectureAudio } from '../native';

/** Accurate captions: download Whisper's model once, then it corrects the live captions every ~30 s. */
function WhisperSection({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isNative) return;
    LectureAudio.whisperStatus().then((s) => {
      setInstalled(s.installed);
      if (s.downloading) setProgress(0);
    });
    const h = LectureAudio.addListener('whisperProgress', (e) => setProgress(e.received / e.total));
    return () => {
      h.then((x) => x.remove());
    };
  }, []);

  const download = async () => {
    setErr(null);
    setProgress(0);
    try {
      await LectureAudio.whisperDownload();
      setInstalled(true);
      setOn(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="whisper-box">
      <b>정확한 자막 (Whisper)</b>
      <div className="muted">
        녹음하는 동안 30초마다 그 구간을 iPad 안에서 다시 듣고 자막을 더 정확한 문장으로 바꿔요. 바뀐 문장으로 번역도 다시 해요.
        목소리가 작거나 억양이 있는 강의에서 차이가 커요 (자막이 30초~1분 늦게 정확해져요).
      </div>
      {!isNative ? (
        <div className="muted">iPad 앱에서만 쓸 수 있어요.</div>
      ) : installed === null ? null : installed ? (
        <>
          <label className="check">
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
            녹음할 때 정확한 자막 쓰기
          </label>
          <button
            className="link small"
            onClick={async () => {
              if (!confirm('정확한 자막 모델(약 570MB)을 지울까요? 다시 쓰려면 다시 받아야 해요.')) return;
              await LectureAudio.whisperDelete();
              setInstalled(false);
            }}
          >
            모델 지우기
          </button>
        </>
      ) : progress != null ? (
        <div className="status">모델 받는 중… {Math.round(progress * 100)}% (약 570MB, Wi‑Fi 권장)</div>
      ) : (
        <button onClick={download}>모델 받기 (약 570MB, 한 번만)</button>
      )}
      {err && <div className="status">⚠️ {err}</div>}
    </div>
  );
}

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
      const { ko: [ko], en: [en] } = await translateLines(['So, uh, this is a martindale, you know, because the expectation is constant.'], null, []);
      setStatus(`✅ ${en ? `"${en}" → ` : ''}"${ko}"`);
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

        <WhisperSection on={s.whisper} setOn={(v) => update({ whisper: v })} />

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
