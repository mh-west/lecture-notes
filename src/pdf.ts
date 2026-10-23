// Legacy build: the modern build uses very new JS (e.g. Map.getOrInsertComputed) that iPad Safari lacks.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PDFDoc = pdfjs.PDFDocumentProxy;

export async function loadPdf(blob: Blob): Promise<PDFDoc> {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

// The document currently open in the viewer (used to pull page text for AI questions).
export const currentPdf: { doc: PDFDoc | null } = { doc: null };

export async function pageText(pageNum: number): Promise<string> {
  const doc = currentPdf.doc;
  if (!doc) return '';
  const content = await (await doc.getPage(pageNum)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim();
}
