import Dexie, { type EntityTable } from 'dexie';

export interface Doc {
  id: string;
  name: string;
  pdf: Blob;
  pages?: number[]; // display order: PDF page numbers, negative ids for added blank pages
  createdAt: number;
  updatedAt: number;
  courseId?: string;
  terms?: string[]; // technical terms auto-extracted from the PDF text (speech-recognition hints)
  termsV?: number; // extraction rules the terms were made with (re-extracted when they change)
  termsAdded?: string[]; // terms the user added for this PDF
  termsRemoved?: string[]; // auto-extracted terms the user removed (kept out even after re-extraction)
  ocrPages?: string[]; // text read from page images when the PDF has no text layer (scans)
}

/** A folder of PDFs for one class. Its info steers caption recognition, summaries and AI questions. */
export interface Course {
  id: string;
  name: string;
  subject: string; // free text: what the class covers, level, prerequisites
  lang: LectureLang;
  vocab: string[]; // user-entered terms
  createdAt: number;
}

export interface Point {
  x: number; // PDF units (viewport scale 1)
  y: number;
  p: number; // pressure 0..1
}

export interface Stroke {
  id: string;
  docId: string;
  page: number; // 1-based
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  points: Point[];
  createdAt: number; // wall clock ms
  recId?: string; // recording active while drawn
  t?: number; // seconds since recording start
  pk?: PencilKitInk; // written with Apple Pencil on the iPad: drawn from PencilKit's own rendering
}

export interface PencilKitInk {
  data: string; // base64 PKDrawing holding just this stroke
  bounds: { x: number; y: number; w: number; h: number }; // rendered area, PDF units
  scale: number; // CSS px per PDF unit when it was written (the PKDrawing's coordinate scale)
}

export interface Recording {
  id: string;
  docId: string;
  startedAt: number;
  endedAt?: number;
  mimeType: string;
  name?: string; // imported file name
  pageLog?: { t: number; page: number }[]; // page on screen from time t (seconds) onwards
  lang?: LectureLang;
}

export type LectureLang = 'en-US' | 'ko-KR';

export interface AudioChunk {
  id?: number;
  recId: string;
  seq: number;
  data: Blob;
}

export interface Segment {
  id: string;
  docId: string;
  recId: string;
  start: number; // seconds since recording start
  end: number;
  text: string;
  ko?: string; // quick line-by-line machine translation
  ko2?: string; // language-model translation using slide context; '' = filler only
}

export interface Summary {
  recId: string;
  docId: string;
  text: string; // Markdown
  createdAt: number;
}

export interface Question {
  id: string;
  docId: string;
  page?: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  image?: Blob;
  prompt: string;
  label: string;
  recId?: string;
  t?: number;
  createdAt: number;
  answer?: string;
}

export const db = new Dexie('lecture-notes') as Dexie & {
  docs: EntityTable<Doc, 'id'>;
  strokes: EntityTable<Stroke, 'id'>;
  recordings: EntityTable<Recording, 'id'>;
  chunks: EntityTable<AudioChunk, 'id'>;
  segments: EntityTable<Segment, 'id'>;
  questions: EntityTable<Question, 'id'>;
  summaries: EntityTable<Summary, 'recId'>;
  courses: EntityTable<Course, 'id'>;
};

db.version(1).stores({
  docs: 'id, updatedAt',
  strokes: 'id, docId, [docId+page]',
  recordings: 'id, docId',
  chunks: '++id, recId, [recId+seq]',
});
db.version(2).stores({
  segments: 'id, docId, recId',
  questions: 'id, docId, createdAt',
});
db.version(3).stores({
  summaries: 'recId, docId',
});
db.version(4).stores({
  docs: 'id, updatedAt, courseId',
  courses: 'id, createdAt',
});

export const uid = () => crypto.randomUUID();

export async function importPdf(file: Blob, name: string, courseId?: string): Promise<string> {
  const id = uid();
  const pdf = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
  await db.docs.put({ id, name: name.replace(/\.pdf$/i, ''), pdf, createdAt: Date.now(), updatedAt: Date.now(), courseId });
  return id;
}

export async function recordingBlob(rec: Recording): Promise<Blob> {
  const chunks = await db.chunks.where('[recId+seq]').between([rec.id, 0], [rec.id, Infinity]).toArray();
  return new Blob(chunks.map((c) => c.data), { type: rec.mimeType });
}
