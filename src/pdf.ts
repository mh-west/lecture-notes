// Legacy build: the modern build uses very new JS (e.g. Map.getOrInsertComputed) that iPad Safari lacks.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// pdf.js reads text with `for await (… of readableStream)`; iPad WebKit's ReadableStream isn't async-iterable yet.
if (!(Symbol.asyncIterator in ReadableStream.prototype)) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream) {
      const reader = this.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export type PDFDoc = pdfjs.PDFDocumentProxy;

export async function loadPdf(blob: Blob): Promise<PDFDoc> {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data }).promise;
}

// The document currently open in the viewer (used to pull page text for AI questions).
// `ocr`: text read from page images, for scanned PDFs without a text layer (index = page - 1).
export const currentPdf: { doc: PDFDoc | null; ocr?: string[] } = { doc: null };

export async function pageText(pageNum: number): Promise<string> {
  const doc = currentPdf.doc;
  if (!doc || pageNum < 1) return ''; // blank pages have no text
  const content = await (await doc.getPage(pageNum)).getTextContent();
  const text = content.items.map((i) => ('str' in i ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim();
  return text.length >= 20 ? text : (currentPdf.ocr?.[pageNum - 1] ?? text);
}

/** Renders a page to a JPEG (base64, no data: prefix) about `width` px wide, for text recognition. */
export async function pageImage(pdf: PDFDoc, pageNum: number, width = 1600): Promise<string> {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = canvas.height = 0;
  return url.split(',')[1];
}
