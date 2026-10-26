// Browser fallback (desktop Chrome / testing): Web Speech API. The iPad app uses the native plugin instead.
import type { TranscriptEvent } from './native';

type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start: () => void; stop: () => void;
};

export function webSpeechAvailable() {
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export function startWebSpeech(lang: string, now: () => number, onEvent: (e: TranscriptEvent) => void, onError: (m: string) => void) {
  const w = window as unknown as Record<string, new () => SR>;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return () => {};
  let stopped = false;
  let rec: SR;
  let segStart: number | null = null;
  const boot = () => {
    rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        segStart ??= now();
        onEvent({ text, start: segStart, end: now(), final: r.isFinal });
        if (r.isFinal) segStart = null;
      }
    };
    rec.onerror = (e) => e.error !== 'no-speech' && e.error !== 'aborted' && onError(e.error);
    rec.onend = () => !stopped && boot(); // browsers end sessions on silence; restart
    rec.start();
  };
  boot();
  return () => {
    stopped = true;
    rec.stop();
  };
}
