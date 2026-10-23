import { create } from 'zustand';
import { db, recordingBlob, uid, type Recording, type Stroke } from './db';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso';

type Op = { type: 'add' | 'delete'; strokes: Stroke[] };

interface State {
  docId: string | null;
  strokes: Stroke[];
  recordings: Recording[];
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

  // playback / review
  playingRecId: string | null;
  replayT: number | null; // when set, only strokes of playingRecId with t <= replayT are shown
  flash: { ids: string[]; nonce: number } | null;
  scrollTo: { page: number; y: number; nonce: number } | null;

  openDoc: (id: string | null) => Promise<void>;
  setTool: (t: Tool) => void;
  setColor: (c: string) => void;
  setSize: (s: number) => void;
  setZoom: (z: number) => void;
  setFingerDraw: (v: boolean) => void;
  setShowOrder: (v: boolean) => void;
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
}

export const audio = new Audio();
let audioRecId: string | null = null;
let audioUrl: string | null = null;

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let wakeLock: WakeLockSentinel | null = null;
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

export const useStore = create<State>((set, get) => ({
  docId: null,
  strokes: [],
  recordings: [],
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
  playingRecId: null,
  replayT: null,
  flash: null,
  scrollTo: null,

  openDoc: async (id) => {
    if (get().activeRec) await get().stopRecording();
    audio.pause();
    if (!id) {
      set({ docId: null, strokes: [], recordings: [], undoStack: [], redoStack: [], replayT: null, playingRecId: null });
      return;
    }
    const [strokes, recordings] = await Promise.all([
      db.strokes.where('docId').equals(id).toArray(),
      db.recordings.where('docId').equals(id).sortBy('startedAt'),
    ]);
    set({ docId: id, strokes, recordings, undoStack: [], redoStack: [], replayT: null, playingRecId: null });
  },

  // Highlighter with a dark ink colour looks like grey mud; default it to yellow.
  setTool: (tool) => set(tool === 'highlighter' && ['#1f2937', '#2563eb', '#9333ea'].includes(get().color) ? { tool, color: '#f59e0b' } : { tool }),
  setColor: (color) => set({ color, tool: get().tool === 'eraser' || get().tool === 'lasso' ? 'pen' : get().tool }),
  setSize: (size) => set({ size }),
  setZoom: (zoom) => set({ zoom }),
  setFingerDraw: (fingerDraw) => set({ fingerDraw }),
  setShowOrder: (showOrder) => set({ showOrder }),

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
    if (!docId || recorder) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    const mimeType = pickMime();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const rec: Recording = { id: uid(), docId, startedAt: Date.now(), mimeType: recorder.mimeType || mimeType };
    await db.recordings.put(rec);
    seq = 0;
    recorder.ondataavailable = (e) => {
      if (e.data.size) db.chunks.add({ recId: rec.id, seq: seq++, data: e.data });
    };
    // Flush every 5s so a crash or closed tab loses at most a few seconds of audio.
    recorder.start(5000);
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null;
    }
    set((st) => ({ activeRec: rec, recStartPerf: performance.now(), recordings: [...st.recordings, rec] }));
  },

  stopRecording: async () => {
    const { activeRec } = get();
    if (!recorder || !activeRec) return;
    const r = recorder;
    await new Promise<void>((resolve) => {
      r.onstop = () => resolve();
      r.stop();
    });
    stream?.getTracks().forEach((t) => t.stop());
    wakeLock?.release().catch(() => {});
    recorder = null;
    stream = null;
    wakeLock = null;
    const endedAt = Date.now();
    await db.recordings.update(activeRec.id, { endedAt });
    set((st) => ({
      activeRec: null,
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
}));
