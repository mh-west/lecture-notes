import { create } from 'zustand';
import { db, recordingBlob, uid, type Question, type Recording, type Segment, type Stroke } from './db';
import { isNative, LectureAudio, nativeFileBlob, type TranscriptEvent } from './native';
import { startWebSpeech, webSpeechAvailable } from './transcribe-web';
import { VOCABULARY } from './vocab';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso';

type Op = { type: 'add' | 'delete'; strokes: Stroke[] };

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/** What the AI-question dialog is about: a lasso region of a page, and/or a caption line. */
export interface AskTarget {
  page?: number;
  bounds?: Bounds;
  segment?: Segment;
  t?: number;
  recId?: string;
}

interface State {
  docId: string | null;
  strokes: Stroke[];
  recordings: Recording[];
  segments: Segment[];
  questions: Question[];
  tool: Tool;
  color: string;
  size: number;
  zoom: number;
  fingerDraw: boolean;
  showOrder: boolean;
  undoStack: Op[];
  redoStack: Op[];

  // recording
  activeRec: Recording | null;
  recStartPerf: number;
  partial: string; // caption text not yet finalised
  captionError: string | null;
  sidePanelTab: 'order' | 'transcript' | 'ai';

  // playback / review
  playingRecId: string | null;
  replayT: number | null; // when set, only strokes of playingRecId with t <= replayT are shown
  flash: { ids: string[]; nonce: number } | null;
  scrollTo: { page: number; y: number; nonce: number } | null;

  ask: AskTarget | null;

  openDoc: (id: string | null) => Promise<void>;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setSize: (s: number) => void;
  setZoom: (z: number) => void;
  setFingerDraw: (v: boolean) => void;
  setShowOrder: (v: boolean) => void;
  setSidePanelTab: (t: State['sidePanelTab']) => void;
  addStroke: (s: Omit<Stroke, 'id' | 'docId' | 'createdAt' | 'recId' | 't'>) => void;
  deleteStrokes: (ids: string[]) => void;
  undo: () => void;
  redo: () => void;
  recTime: () => number | undefined;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  playAt: (recId: string, t: number) => Promise<void>;
  setReplayT: (t: number | null) => void;
  focusStrokes: (page: number, y: number, ids: string[]) => void;
  translateSegment: (id: string) => Promise<void>;
  openAsk: (target: AskTarget | null) => void;
  saveQuestion: (q: Omit<Question, 'id' | 'docId' | 'createdAt'>) => Promise<void>;
  updateQuestion: (id: string, patch: Partial<Question>) => void;
  deleteQuestion: (id: string) => void;
}

export const audio = new Audio();
let audioRecId: string | null = null;
let audioUrl: string | null = null;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let wakeLock: WakeLockSentinel | null = null;
let stopCaptions: (() => void) | null = null;
let seq = 0;

function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function applyOp(op: Op, invert: boolean) {
  const adding = (op.type === 'add') !== invert;
  if (adding) await db.strokes.bulkPut(op.strokes);
  else await db.strokes.bulkDelete(op.strokes.map((s) => s.id));
}

export const useStore = create<State>((set, get) => {
  const onCaption = (rec: Recording) => (e: TranscriptEvent) => {
    if (get().activeRec?.id !== rec.id) return;
    if (!e.final) {
      set({ partial: e.text });
      return;
    }
    const seg: Segment = { id: uid(), docId: rec.docId, recId: rec.id, start: e.start, end: e.end, text: e.text };
    set((st) => ({ segments: [...st.segments, seg], partial: '' }));
    db.segments.put(seg);
    if (isNative) get().translateSegment(seg.id);
  };

  return {
    docId: null,
    strokes: [],
    recordings: [],
    segments: [],
    questions: [],
    tool: 'pen',
    color: '#1f2937',
    size: 2.2,
    zoom: 1,
    fingerDraw: false,
    showOrder: false,
    undoStack: [],
    redoStack: [],
    activeRec: null,
    recStartPerf: 0,
    partial: '',
    captionError: null,
    sidePanelTab: 'transcript',
    playingRecId: null,
    replayT: null,
    flash: null,
    scrollTo: null,
    ask: null,

    openDoc: async (id) => {
      if (get().activeRec) await get().stopRecording();
      audio.pause();
      const reset = { undoStack: [], redoStack: [], replayT: null, playingRecId: null, ask: null, partial: '' };
      if (!id) {
        set({ docId: null, strokes: [], recordings: [], segments: [], questions: [], ...reset });
        return;
      }
      const [strokes, recordings, segments, questions] = await Promise.all([
        db.strokes.where('docId').equals(id).toArray(),
        db.recordings.where('docId').equals(id).sortBy('startedAt'),
        db.segments.where('docId').equals(id).sortBy('start'),
        db.questions.where('docId').equals(id).sortBy('createdAt'),
      ]);
      set({ docId: id, strokes, recordings, segments, questions, ...reset });
    },

    // Highlighter with a dark ink colour looks like grey mud; default it to yellow.
    setTool: (tool) =>
      set(tool === 'highlighter' && ['#1f2937', '#2563eb', '#9333ea'].includes(get().color) ? { tool, color: '#f59e0b' } : { tool }),
    setColor: (color) => set({ color, tool: get().tool === 'eraser' || get().tool === 'lasso' ? 'pen' : get().tool }),
    setSize: (size) => set({ size }),
    setZoom: (zoom) => set({ zoom }),
    setFingerDraw: (fingerDraw) => set({ fingerDraw }),
    setShowOrder: (showOrder) => set({ showOrder }),
    setSidePanelTab: (sidePanelTab) => set({ sidePanelTab }),

    recTime: () => {
      const { activeRec, recStartPerf } = get();
      return activeRec ? (performance.now() - recStartPerf) / 1000 : undefined;
    },

    addStroke: (s) => {
      const { docId, activeRec } = get();
      if (!docId) return;
      const stroke: Stroke = {
        ...s,
        id: uid(),
        docId,
        createdAt: Date.now(),
        recId: activeRec?.id,
        t: get().recTime(),
      };
      const op: Op = { type: 'add', strokes: [stroke] };
      set((st) => ({ strokes: [...st.strokes, stroke], undoStack: [...st.undoStack, op], redoStack: [] }));
      db.strokes.put(stroke);
      db.docs.update(docId, { updatedAt: Date.now() });
    },

    deleteStrokes: (ids) => {
      if (!ids.length) return;
      const idSet = new Set(ids);
      const removed = get().strokes.filter((s) => idSet.has(s.id));
      const op: Op = { type: 'delete', strokes: removed };
      set((st) => ({ strokes: st.strokes.filter((s) => !idSet.has(s.id)), undoStack: [...st.undoStack, op], redoStack: [] }));
      db.strokes.bulkDelete(ids);
    },

    undo: () => {
      const op = get().undoStack.at(-1);
      if (!op) return;
      applyOp(op, true);
      const ids = new Set(op.strokes.map((s) => s.id));
      set((st) => ({
        strokes: op.type === 'add' ? st.strokes.filter((s) => !ids.has(s.id)) : [...st.strokes, ...op.strokes],
        undoStack: st.undoStack.slice(0, -1),
        redoStack: [...st.redoStack, op],
      }));
    },

    redo: () => {
      const op = get().redoStack.at(-1);
      if (!op) return;
      applyOp(op, false);
      const ids = new Set(op.strokes.map((s) => s.id));
      set((st) => ({
        strokes: op.type === 'add' ? [...st.strokes, ...op.strokes] : st.strokes.filter((s) => !ids.has(s.id)),
        redoStack: st.redoStack.slice(0, -1),
        undoStack: [...st.undoStack, op],
      }));
    },

    startRecording: async () => {
      const { docId } = get();
      if (!docId || get().activeRec) return;
      audio.pause();
      const rec: Recording = { id: uid(), docId, startedAt: Date.now(), mimeType: 'audio/mp4' };
      set({ captionError: null, partial: '' });

      if (isNative) {
        // Native side records to an m4a and transcribes the same mic stream on-device.
        const perm = await LectureAudio.prepare();
        if (!perm.mic) throw new Error('마이크 권한이 필요해요 (설정 > 강의노트)');
        const h1 = await LectureAudio.addListener('transcript', onCaption(rec));
        const h2 = await LectureAudio.addListener('error', (e) => set({ captionError: e.message }));
        stopCaptions = () => {
          h1.remove();
          h2.remove();
        };
        if (!perm.speech) set({ captionError: '음성 인식 권한이 없어 자막 없이 녹음해요 (설정 > 강의노트)' });
        await LectureAudio.start({ vocabulary: VOCABULARY });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
        });
        const mimeType = pickMime();
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        rec.mimeType = recorder.mimeType || mimeType;
        seq = 0;
        recorder.ondataavailable = (e) => {
          if (e.data.size) db.chunks.add({ recId: rec.id, seq: seq++, data: e.data });
        };
        // Flush every 5s so a crash or closed tab loses at most a few seconds of audio.
        recorder.start(5000);
        if (webSpeechAvailable()) {
          stopCaptions = startWebSpeech(() => get().recTime() ?? 0, onCaption(rec), (m) => set({ captionError: `자막 오류: ${m}` }));
        } else {
          set({ captionError: '이 브라우저는 자막을 지원하지 않아요. iPad 앱에서는 기기 내 자막이 동작해요.' });
        }
      }

      await db.recordings.put(rec);
      try {
        wakeLock = await navigator.wakeLock?.request('screen');
      } catch {
        wakeLock = null;
      }
      set((st) => ({ activeRec: rec, recStartPerf: performance.now(), recordings: [...st.recordings, rec] }));
    },

    stopRecording: async () => {
      const { activeRec } = get();
      if (!activeRec) return;
      if (isNative) {
        const { uri } = await LectureAudio.stop();
        stopCaptions?.();
        await db.chunks.add({ recId: activeRec.id, seq: 0, data: await nativeFileBlob(uri) });
      } else if (recorder) {
        const r = recorder;
        stopCaptions?.();
        await new Promise<void>((resolve) => {
          r.onstop = () => resolve();
          r.stop();
        });
        stream?.getTracks().forEach((t) => t.stop());
      }
      wakeLock?.release().catch(() => {});
      recorder = null;
      stream = null;
      wakeLock = null;
      stopCaptions = null;
      const endedAt = Date.now();
      await db.recordings.update(activeRec.id, { endedAt });
      set((st) => ({
        activeRec: null,
        partial: '',
        recordings: st.recordings.map((r) => (r.id === activeRec.id ? { ...r, endedAt } : r)),
      }));
    },

    playAt: async (recId, t) => {
      if (get().activeRec?.id === recId) return; // still recording this one
      if (audioRecId !== recId) {
        const rec = get().recordings.find((r) => r.id === recId);
        if (!rec) return;
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = URL.createObjectURL(await recordingBlob(rec));
        audio.src = audioUrl;
        audioRecId = recId;
        await new Promise((res) => audio.addEventListener('loadedmetadata', res, { once: true }));
      }
      audio.currentTime = Math.max(0, t - 2); // start a bit earlier for context
      await audio.play();
      set({ playingRecId: recId });
    },

    setReplayT: (replayT) => set({ replayT }),

    focusStrokes: (page, y, ids) =>
      set({ scrollTo: { page, y, nonce: Math.random() }, flash: { ids, nonce: Math.random() } }),

    translateSegment: async (id) => {
      const seg = get().segments.find((s) => s.id === id);
      if (!seg || !isNative) return;
      try {
        const { text } = await LectureAudio.translate({ text: seg.text });
        set((st) => ({ segments: st.segments.map((s) => (s.id === id ? { ...s, ko: text } : s)) }));
        db.segments.update(id, { ko: text });
      } catch (e) {
        set({ captionError: e instanceof Error ? e.message : String(e) });
      }
    },

    openAsk: (ask) => set({ ask, tool: get().tool === 'lasso' && ask ? 'lasso' : get().tool }),

    saveQuestion: async (q) => {
      const { docId } = get();
      if (!docId) return;
      const question: Question = { ...q, id: uid(), docId, createdAt: Date.now() };
      set((st) => ({ questions: [...st.questions, question] }));
      await db.questions.put(question);
    },

    updateQuestion: (id, patch) => {
      set((st) => ({ questions: st.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) }));
      db.questions.update(id, patch);
    },

    deleteQuestion: (id) => {
      set((st) => ({ questions: st.questions.filter((q) => q.id !== id) }));
      db.questions.delete(id);
    },
  };
});
