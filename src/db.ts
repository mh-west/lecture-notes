import Dexie, { type EntityTable } from 'dexie';

export interface Doc {
  id: string;
  name: string;
  pdf: Blob;
  createdAt: number;
  updatedAt: number;
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
}

export interface Recording {
  id: string;
  docId: string;
  startedAt: number;
  endedAt?: number;
  mimeType: string;
}

export interface AudioChunk {
  id?: number;
  recId: string;
  seq: number;
  data: Blob;
}

export const db = new Dexie('lecture-notes') as Dexie & {
  docs: EntityTable<Doc, 'id'>;
  strokes: EntityTable<Stroke, 'id'>;
  recordings: EntityTable<Recording, 'id'>;
  chunks: EntityTable<AudioChunk, 'id'>;
};

db.version(1).stores({
  docs: 'id, updatedAt',
  strokes: 'id, docId, [docId+page]',
  recordings: 'id, docId',
  chunks: '++id, recId, [recId+seq]',
});

export const uid = () => crypto.randomUUID();

export async function recordingBlob(rec: Recording): Promise<Blob> {
  const chunks = await db.chunks.where('[recId+seq]').between([rec.id, 0], [rec.id, Infinity]).toArray();
  return new Blob(chunks.map((c) => c.data), { type: rec.mimeType });
}
