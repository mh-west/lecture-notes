import { Directory, Filesystem } from '@capacitor/filesystem';
import { create } from 'zustand';
import { db, recordingBlob, uid, type Course, type LectureLang, type Question, type Recording, type Segment, type Stroke, type Summary } from './db';
import { fmtTime } from './ink';
import { engineProblem, loadSettings, summarize, translateLines, type Glossary, type PageContext } from './llm';
import { currentPdf, pageText } from './pdf';
import { isNative, LectureAudio, nativeFileBlob, type TranscriptEvent } from './native';
import { startWebSpeech, webSpeechAvailable } from './transcribe-web';
import { recognitionVocabulary } from './terms';

function lsGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

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
  summaries: Summary[];
  tool: Tool;
  color: string;
  size: number;
  zoom: number;
  fingerDraw: boolean;
  showOrder: boolean;
  overview: boolean;
  undoStack: Op[];
  redoStack: Op[];

  // recording
  activeRec: Recording | null;
  recStartPerf: number;
  partial: string; // caption text not yet finalised
  captionError: string | null;
  sidePanelTab: 'order' | 'transcript' | 'summary' | 'terms' | 'ai';
  sideOpen: boolean;
  lang: LectureLang; // lecture language: per-document override, else the course's language
  course: Course | null; // folder the open PDF belongs to

  // playback / review
  playingRecId: string | null;
  replayT: number | null; // when set, only strokes of playingRecId with t <= replayT are shown
  flash: { ids: string[]; nonce: number } | null;
  scrollTo: { page: number; y: number; nonce: number; jump?: boolean } | null;
  importing: { seconds: number; duration: number } | null; // an imported recording being transcribed
  viewPage: number; // page key in the middle of the viewer
  pageOrder: number[]; // page keys in display order (see Doc.pages)
  refining: { done: number; total: number } | null; // refineAll progress
  refineError: string | null; // set when live refinement stopped (no key, model unavailable…)
  summarizing: { recId: string; msg: string } | null;

  ask: AskTarget | null;

  openDoc: (id: string | null) => Promise<void>;
  setTool: (t: Tool) => void;
  toggleEraser: () => void;
  setColor: (c: string) => void;
  setSize: (s: number) => void;
  setZoom: (z: number) => void;
  setFingerDraw: (v: boolean) => void;
  setShowOrder: (v: boolean) => void;
  setOverview: (v: boolean) => void;
  goToPage: (page: number) => void;
  setSidePanelTab: (t: State['sidePanelTab']) => void;
  setSideOpen: (v: boolean) => void;
  setLang: (l: LectureLang) => void;
  /** `at`: when the stroke was started (wall clock ms), if earlier than now; `id`: preassigned id. */
  addStroke: (s: Omit<Stroke, 'id' | 'docId' | 'createdAt' | 'recId' | 't'>, opts?: { at?: number; id?: string }) => Stroke | undefined;
  deleteStrokes: (ids: string[]) => void;
  undo: () => void;
  redo: () => void;
  recTime: () => number | undefined;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  importRecording: () => Promise<void>;
  setViewPage: (page: number) => void;
  setPageOrder: (order: number[]) => void;
  addBlankPage: () => Promise<void>;
  deleteBlankPage: (key: number) => Promise<void>;
  /** Removes a recording with its audio, captions and summary; strokes written during it stay, untimed. */
  deleteRecording: (recId: string) => Promise<void>;
  /** Transcribe a finished recording again in another language (e.g. a Korean lecture recorded as English). */
  retranscribe: (recId: string, lang: LectureLang) => Promise<void>;
  refineAll: (recId: string) => Promise<void>;
  summarizeRec: (recId: string) => Promise<void>;
  summarizeRange: (from: number, to: number) => Promise<string | undefined>;
  playAt: (recId: string, t: number) => Promise<void>;
  setReplayT: (t: number | null) => void;
  focusStrokes: (page: number, y: number, ids: string[]) => void;
  translateSegment: (id: string) => Promise<void>;
  translateAll: (recId: string) => Promise<void>;
  translatingAll: boolean;
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
let refineChain: Promise<void> = Promise.resolve();
let stopping = false; // a stop is in progress; repeated taps are ignored
let toolBeforeEraser: Tool = 'pen';
const inFlight = new Set<string>(); // segment ids being refined

const blobBase64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

const errMsg = (e: unknown) => {
  // Keep the stack in the device log; WebKit's "undefined is not a function" says nothing on its own.
  console.error('[lecture-notes]', e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : e);
  return e instanceof Error ? e.message : String(e);
};

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
  // ---- refined translation (language model + slide context) ----

  /** Page on screen at time t of a recording; recordings without a page log use the page open now. */
  const pageAt = (recId: string, t: number) => {
    const rec = get().activeRec?.id === recId ? get().activeRec : get().recordings.find((r) => r.id === recId);
    let page = get().viewPage;
    for (const e of rec?.pageLog ?? []) if (e.t <= t) page = e.page;
    return page;
  };

  const pageContext = async (page: number): Promise<PageContext | null> => {
    if (!currentPdf.doc) return null;
    const order = get().pageOrder;
    const i = order.indexOf(page);
    const [current, prev, next] = await Promise.all([
      pageText(page),
      i > 0 ? pageText(order[i - 1]) : Promise.resolve(undefined),
      i >= 0 && i < order.length - 1 ? pageText(order[i + 1]) : Promise.resolve(undefined),
    ]);
    return { page, current, prev, next };
  };

  /** Course name/subject and key terms (folder terms + terms found in its PDFs) for translation and summaries. */
  const glossary = async (): Promise<Glossary | undefined> => {
    const { docId, course, lang } = get();
    if (!docId) return undefined;
    return { course: course?.name, subject: course?.subject, terms: await recognitionVocabulary(docId, course, lang) };
  };

  const unrefined = (recId: string) =>
    get().segments.filter((s) => s.recId === recId && s.ko2 === undefined && !inFlight.has(s.id)).sort((a, b) => a.start - b.start);

  const refineBatch = async (recId: string, batch: Segment[]) => {
    const before = get().segments
      .filter((s) => s.recId === recId && s.end <= batch[0].start)
      .sort((a, b) => a.start - b.start)
      .slice(-4)
      .map((s) => s.text);
    const ctx = await pageContext(pageAt(recId, (batch[0].start + batch[batch.length - 1].end) / 2));
    const out = await translateLines(batch.map((s) => s.text), ctx, before, await glossary());
    const ko2 = new Map(batch.map((s, i) => [s.id, out[i] ?? '']));
    set((st) => ({ segments: st.segments.map((s) => (ko2.has(s.id) ? { ...s, ko2: ko2.get(s.id) } : s)) }));
    await Promise.all(batch.map((s) => db.segments.update(s.id, { ko2: ko2.get(s.id) })));
  };

  // While recording: refine every few lines (or ~20s of speech), one request at a time.
  const maybeRefine = (recId: string, flush = false) => {
    if (!loadSettings().refine || get().refineError) return;
    const pending = unrefined(recId);
    if (!pending.length) return;
    if (!flush && pending.length < 4 && pending[pending.length - 1].end - pending[0].start < 20) return;
    const batch = pending.slice(0, 8);
    batch.forEach((s) => inFlight.add(s.id));
    refineChain = refineChain
      .then(() => refineBatch(recId, batch))
      .catch((e) => set({ refineError: errMsg(e), captionError: `다듬은 번역을 멈췄어요: ${errMsg(e)}` }))
      .finally(() => {
        batch.forEach((s) => inFlight.delete(s.id));
        maybeRefine(recId, flush);
      });
  };

  // Stop the recorder and keep the audio. Always clears the recording state, even when the native side
  // had already stopped (a second tap, or after a crash), so the app can never stay stuck "recording".
  const finishRecording = async (activeRec: Recording) => {
    if (isNative) {
      try {
        const { uri } = await LectureAudio.stop();
        await db.chunks.add({ recId: activeRec.id, seq: 0, data: await nativeFileBlob(uri) });
        Filesystem.deleteFile({ path: uri }).catch(() => {}); // the app's database now holds the audio
      } catch (e) {
        set({ captionError: `녹음을 저장하지 못했어요: ${errMsg(e)}` });
      }
      stopCaptions?.();
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
  };

  const onCaption = (rec: Recording) => (e: TranscriptEvent) => {
    if (get().activeRec?.id !== rec.id) return;
    if (!e.final) {
      set({ partial: e.text });
      return;
    }
    const seg: Segment = { id: uid(), docId: rec.docId, recId: rec.id, start: e.start, end: e.end, text: e.text };
    set((st) => ({ segments: [...st.segments, seg], partial: '' }));
    db.segments.put(seg);
    // Korean lectures need no translation.
    if (rec.lang !== 'ko-KR') {
      if (isNative) get().translateSegment(seg.id);
      maybeRefine(rec.id);
    }
  };

  return {
    docId: null,
    strokes: [],
    recordings: [],
    segments: [],
    questions: [],
    summaries: [],
    tool: 'pen',
    color: '#1f2937',
    size: 2.2,
    zoom: 1,
    fingerDraw: false,
    showOrder: false,
    overview: false,
    undoStack: [],
    redoStack: [],
    activeRec: null,
    recStartPerf: 0,
    partial: '',
    captionError: null,
    sidePanelTab: 'transcript',
    sideOpen: lsGet('sideOpen') !== '0',
    lang: 'en-US',
    course: null,
    playingRecId: null,
    replayT: null,
    flash: null,
    scrollTo: null,
    importing: null,
    viewPage: 1,
    pageOrder: [],
    refining: null,
    refineError: null,
    summarizing: null,
    translatingAll: false,
    ask: null,

    openDoc: async (id) => {
      if (get().activeRec) await get().stopRecording();
      audio.pause();
      const reset = { undoStack: [], redoStack: [], replayT: null, playingRecId: null, ask: null, partial: '', viewPage: 1, pageOrder: [] };
      if (!id) {
        set({ docId: null, strokes: [], recordings: [], segments: [], questions: [], summaries: [], course: null, ...reset });
        return;
      }
      const [strokes, recordings, segments, questions, summaries] = await Promise.all([
        db.strokes.where('docId').equals(id).toArray(),
        db.recordings.where('docId').equals(id).sortBy('startedAt'),
        db.segments.where('docId').equals(id).sortBy('start'),
        db.questions.where('docId').equals(id).sortBy('createdAt'),
        db.summaries.where('docId').equals(id).toArray(),
      ]);
      const doc = await db.docs.get(id);
      const course = (doc?.courseId && (await db.courses.get(doc.courseId))) || null;
      const saved = lsGet(`lang:${id}`);
      const lang: LectureLang = saved === 'ko-KR' || saved === 'en-US' ? saved : (course?.lang ?? 'en-US');
      set({ docId: id, strokes, recordings, segments, questions, summaries, lang, course, ...reset });
    },

    // Highlighter with a dark ink colour looks like grey mud; default it to yellow.
    setTool: (tool) =>
      set(tool === 'highlighter' && ['#1f2937', '#2563eb', '#9333ea'].includes(get().color) ? { tool, color: '#f59e0b' } : { tool }),
    // Apple Pencil double-tap: eraser ↔ the tool in use before it.
    toggleEraser: () => {
      const { tool } = get();
      if (tool === 'eraser') set({ tool: toolBeforeEraser });
      else {
        toolBeforeEraser = tool === 'lasso' ? 'pen' : tool;
        set({ tool: 'eraser' });
      }
    },
    setColor: (color) => set({ color, tool: get().tool === 'eraser' || get().tool === 'lasso' ? 'pen' : get().tool }),
    setSize: (size) => set({ size }),
    setZoom: (zoom) => set({ zoom }),
    setFingerDraw: (fingerDraw) => set({ fingerDraw }),
    setShowOrder: (showOrder) => set({ showOrder }),
    setOverview: (overview) => set({ overview }),
    goToPage: (page) => set({ overview: false, scrollTo: { page, y: 0, nonce: Math.random(), jump: true } }),
    setSidePanelTab: (sidePanelTab) => set({ sidePanelTab }),
    setSideOpen: (sideOpen) => {
      lsSet('sideOpen', sideOpen ? '1' : '0');
      set({ sideOpen });
    },
    setLang: (lang) => {
      const { docId } = get();
      if (docId) lsSet(`lang:${docId}`, lang);
      set({ lang });
    },

    recTime: () => {
      const { activeRec, recStartPerf } = get();
      return activeRec ? (performance.now() - recStartPerf) / 1000 : undefined;
    },

    addStroke: (s, opts) => {
      const { docId, activeRec } = get();
      if (!docId) return;
      const at = opts?.at ?? Date.now();
      const rt = get().recTime();
      const stroke: Stroke = {
        ...s,
        id: opts?.id ?? uid(),
        docId,
        createdAt: at,
        recId: activeRec?.id,
        t: rt == null ? undefined : Math.max(0, rt - (Date.now() - at) / 1000),
      };
      const op: Op = { type: 'add', strokes: [stroke] };
      set((st) => ({ strokes: [...st.strokes, stroke], undoStack: [...st.undoStack, op], redoStack: [] }));
      db.strokes.put(stroke);
      db.docs.update(docId, { updatedAt: Date.now() });
      return stroke;
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
      const lang = get().lang;
      const rec: Recording = { id: uid(), docId, startedAt: Date.now(), mimeType: 'audio/mp4', lang, pageLog: [{ t: 0, page: get().viewPage }] };
      set({ captionError: null, partial: '', refineError: null });
      if (loadSettings().refine && lang !== 'ko-KR') {
        engineProblem().then((p) => p && set({ refineError: p, captionError: `다듬은 번역 없이 녹음해요: ${p}` }));
      }

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
        await LectureAudio.start({ vocabulary: await recognitionVocabulary(docId, get().course, lang), locale: lang });
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
          stopCaptions = startWebSpeech(lang, () => get().recTime() ?? 0, onCaption(rec), (m) => set({ captionError: `자막 오류: ${m}` }));
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
      if (!activeRec || stopping) return;
      stopping = true;
      try {
        await finishRecording(activeRec);
      } finally {
        stopping = false;
      }
      if (loadSettings().refine && !get().refineError) {
        // Finish the last lines (English lectures only), then write the lecture summary.
        const korean = activeRec.lang === 'ko-KR';
        refineChain
          .then(() => (korean ? undefined : get().refineAll(activeRec.id)))
          .then(() => get().summarizeRec(activeRec.id));
      }
    },

    setViewPage: (page) => {
      if (page === get().viewPage) return;
      set({ viewPage: page });
      const rec = get().activeRec;
      const t = get().recTime();
      if (!rec || t == null) return;
      const pageLog = [...(rec.pageLog ?? []), { t, page }];
      set((st) => ({
        activeRec: { ...rec, pageLog },
        recordings: st.recordings.map((r) => (r.id === rec.id ? { ...r, pageLog } : r)),
      }));
      db.recordings.update(rec.id, { pageLog });
    },

    setPageOrder: (pageOrder) => set({ pageOrder }),

    // A blank page goes right after the page on screen.
    addBlankPage: async () => {
      const { docId, pageOrder, viewPage } = get();
      if (!docId || !pageOrder.length) return;
      const key = Math.min(0, ...pageOrder) - 1;
      const order = [...pageOrder];
      order.splice(order.indexOf(viewPage) + 1, 0, key);
      set({ pageOrder: order });
      await db.docs.update(docId, { pages: order });
      get().goToPage(key);
    },

    retranscribe: async (recId, lang) => {
      const { docId } = get();
      const rec = get().recordings.find((r) => r.id === recId);
      if (!docId || !rec || !isNative || get().importing || get().activeRec?.id === recId) return;
      const blob = await recordingBlob(rec);
      // The speech model reads a file: write the saved audio out for it.
      const { uri } = await Filesystem.writeFile({ path: `redo-${recId}.m4a`, data: await blobBase64(blob), directory: Directory.Cache });
      const duration = rec.endedAt ? (rec.endedAt - rec.startedAt) / 1000 : 0;
      set({ importing: { seconds: 0, duration }, captionError: null, sidePanelTab: 'transcript' });
      const h = await LectureAudio.addListener('fileProgress', (e) =>
        set((st) => ({ importing: st.importing && { ...st.importing, seconds: e.seconds } })),
      );
      try {
        const vocabulary = await recognitionVocabulary(docId, get().course, lang);
        const { segments } = await LectureAudio.transcribeFile({ path: decodeURIComponent(new URL(uri).pathname), vocabulary, locale: lang });
        const segs: Segment[] = segments.map((x) => ({ id: uid(), docId, recId, ...x }));
        await db.transaction('rw', [db.segments, db.summaries, db.recordings], async () => {
          await db.segments.where('recId').equals(recId).delete();
          await db.segments.bulkPut(segs);
          await db.summaries.delete(recId); // it described the old captions
          await db.recordings.update(recId, { lang });
        });
        set((st) => ({
          segments: [...st.segments.filter((x) => x.recId !== recId), ...segs],
          summaries: st.summaries.filter((x) => x.recId !== recId),
          recordings: st.recordings.map((r) => (r.id === recId ? { ...r, lang } : r)),
        }));
      } catch (e) {
        set({ captionError: `다시 받지 못했어요: ${errMsg(e)}` });
        return;
      } finally {
        h.remove();
        Filesystem.deleteFile({ path: uri }).catch(() => {});
        set({ importing: null });
      }
      // Same follow-up as a fresh recording: English gets refined translations, both get a summary.
      if (loadSettings().refine && !(await engineProblem())) {
        if (lang !== 'ko-KR') await get().refineAll(recId);
        await get().summarizeRec(recId);
      } else if (lang !== 'ko-KR') {
        await get().translateAll(recId);
      }
    },

    deleteRecording: async (recId) => {
      const { docId } = get();
      if (!docId || get().activeRec?.id === recId) return;
      if (audioRecId === recId) {
        audio.pause();
        audio.removeAttribute('src');
        audioRecId = null;
      }
      const untime = (s: Stroke): Stroke => (s.recId === recId ? { ...s, recId: undefined, t: undefined } : s);
      await db.transaction('rw', [db.recordings, db.chunks, db.segments, db.summaries, db.strokes], async () => {
        await db.chunks.where('recId').equals(recId).delete();
        await db.segments.where('recId').equals(recId).delete();
        await db.summaries.delete(recId);
        await db.strokes.where('docId').equals(docId).filter((s) => s.recId === recId).modify((s) => {
          delete s.recId;
          delete s.t;
        });
        await db.recordings.delete(recId);
      });
      set((st) => ({
        recordings: st.recordings.filter((r) => r.id !== recId),
        segments: st.segments.filter((x) => x.recId !== recId),
        summaries: st.summaries.filter((x) => x.recId !== recId),
        strokes: st.strokes.map(untime),
        playingRecId: st.playingRecId === recId ? null : st.playingRecId,
        replayT: st.playingRecId === recId ? null : st.replayT,
      }));
    },

    deleteBlankPage: async (key) => {
      const { docId, pageOrder } = get();
      if (!docId || key >= 0) return;
      const order = pageOrder.filter((k) => k !== key);
      const gone = get().strokes.filter((s) => s.page === key).map((s) => s.id);
      set((st) => ({ pageOrder: order, strokes: st.strokes.filter((s) => s.page !== key) }));
      await db.strokes.bulkDelete(gone);
      await db.docs.update(docId, { pages: order });
    },

    refineAll: async (recId) => {
      if (get().refining) return;
      const problem = await engineProblem();
      if (problem) {
        set({ captionError: problem });
        return;
      }
      const total = unrefined(recId).length;
      set({ refining: { done: 0, total }, refineError: null, captionError: null });
      try {
        for (let batch = unrefined(recId).slice(0, 8); batch.length; batch = unrefined(recId).slice(0, 8)) {
          await refineBatch(recId, batch);
          set({ refining: { done: total - unrefined(recId).length, total } });
        }
      } catch (e) {
        set({ captionError: `다듬은 번역 실패: ${errMsg(e)}` });
      } finally {
        set({ refining: null });
      }
    },

    // Summary of pages from..to (positions as shown): their slides plus whatever was said while they were on screen.
    summarizeRange: async (from, to) => {
      const { docId, pageOrder } = get();
      if (!docId || get().summarizing) return;
      const problem = await engineProblem();
      if (problem) {
        set({ captionError: problem });
        return;
      }
      const keys = pageOrder.slice(from - 1, to);
      const inRange = new Set(keys);
      const id = `range:${docId}:${from}-${to}`;
      const lines: string[] = [];
      get().recordings.forEach((rec, i) => {
        if (!rec.pageLog?.length) return; // imported audio has no record of which page was on screen
        for (const s of get().segments.filter((x) => x.recId === rec.id).sort((a, b) => a.start - b.start)) {
          if (inRange.has(pageAt(rec.id, s.start))) lines.push(`[녹음${i + 1} ${fmtTime(s.start)}] ${s.text}`);
        }
      });
      const slides = (await Promise.all(keys.map(async (k, i) => `### p.${from + i}\n${await pageText(k)}`))).join('\n\n');
      set({ summarizing: { recId: id, msg: '요약 준비 중…' } });
      try {
        const text = await summarize(lines.join('\n'), slides, (msg) => set({ summarizing: { recId: id, msg } }), await glossary());
        const sum: Summary = { recId: id, docId, text, createdAt: Date.now() };
        await db.summaries.put(sum);
        set((st) => ({ summaries: [...st.summaries.filter((x) => x.recId !== id), sum] }));
        return id;
      } catch (e) {
        set({ captionError: `요약 실패: ${errMsg(e)}` });
      } finally {
        set({ summarizing: null });
      }
    },

    summarizeRec: async (recId) => {
      if (get().summarizing) return;
      const problem = await engineProblem();
      if (problem) {
        set({ captionError: problem });
        return;
      }
      const rec = get().recordings.find((r) => r.id === recId);
      const segs = get().segments.filter((s) => s.recId === recId).sort((a, b) => a.start - b.start);
      if (!rec || !segs.length) return;
      const transcript = segs.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
      const pages = [...new Set((rec.pageLog ?? []).map((e) => e.page))].sort((a, b) => a - b).slice(0, 30);
      const slides = (await Promise.all(pages.map(async (p) => `### p.${p}\n${await pageText(p)}`))).join('\n\n');
      set({ summarizing: { recId, msg: '요약 준비 중…' } });
      try {
        const text = await summarize(transcript, slides, (msg) => set({ summarizing: { recId, msg } }), await glossary());
        const sum: Summary = { recId, docId: rec.docId, text, createdAt: Date.now() };
        await db.summaries.put(sum);
        set((st) => ({ summaries: [...st.summaries.filter((x) => x.recId !== recId), sum] }));
      } catch (e) {
        set({ captionError: `요약 실패: ${errMsg(e)}` });
      } finally {
        set({ summarizing: null });
      }
    },

    importRecording: async () => {
      const { docId } = get();
      if (!docId || !isNative || get().importing) return;
      let f;
      try {
        f = await LectureAudio.pickAudio();
      } catch (e) {
        if ((e as { code?: string }).code === 'CANCELED') return;
        throw e;
      }
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = { mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', caf: 'audio/x-caf' }[ext] ?? 'audio/mp4';
      const rec: Recording = { id: uid(), docId, startedAt: f.createdAt, endedAt: f.createdAt + f.duration * 1000, mimeType, name: f.name };
      await db.chunks.add({ recId: rec.id, seq: 0, data: await nativeFileBlob(f.uri) });
      await db.recordings.put(rec);
      set((st) => ({
        recordings: [...st.recordings, rec].sort((a, b) => a.startedAt - b.startedAt),
        importing: { seconds: 0, duration: f.duration },
        captionError: null,
        sidePanelTab: 'transcript',
      }));
      const h = await LectureAudio.addListener('fileProgress', (e) =>
        set((st) => ({ importing: st.importing && { ...st.importing, seconds: e.seconds } })),
      );
      try {
        const vocabulary = await recognitionVocabulary(docId, get().course, 'en-US'); // file transcription is English-only
        const { segments } = await LectureAudio.transcribeFile({ path: f.path, vocabulary });
        const segs: Segment[] = segments.map((s) => ({ id: uid(), docId, recId: rec.id, ...s }));
        await db.segments.bulkPut(segs);
        set((st) => ({ segments: [...st.segments, ...segs] }));
        if (loadSettings().refine && !(await engineProblem())) {
          await get().refineAll(rec.id);
          await get().summarizeRec(rec.id);
        } else {
          await get().translateAll(rec.id);
        }
      } catch (e) {
        set({ captionError: e instanceof Error ? e.message : String(e) });
      } finally {
        h.remove();
        Filesystem.deleteFile({ path: f.uri }).catch(() => {}); // kept only until transcribed; the database has it
        set({ importing: null });
      }
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

    // Fill in missing Korean lines one by one; stop at the first failure (its error is shown).
    translateAll: async (recId) => {
      if (get().translatingAll) return;
      set({ translatingAll: true, captionError: null });
      try {
        for (const s of get().segments.filter((x) => x.recId === recId && !x.ko)) {
          await get().translateSegment(s.id);
          if (!get().segments.find((x) => x.id === s.id)?.ko) break;
        }
      } finally {
        set({ translatingAll: false });
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

if (isNative) {
  let lastTap = 0;
  LectureAudio.addListener('pencilDoubleTap', () => {
    if (performance.now() - lastTap < 300) return; // one physical tap, even if both delegate callbacks fire
    lastTap = performance.now();
    useStore.getState().toggleEraser();
  });
}
