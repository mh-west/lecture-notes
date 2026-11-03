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

/**
 * Loads pdf.js's extra data (character maps, standard fonts, image decoders) with fetch. pdf.js itself
 * only fetches http(s) URLs and falls back to XMLHttpRequest for the app's capacitor:// pages, which on
 * the iPad could leave a page's rendering waiting forever (a blank white page). A timeout turns any hang
 * into an error, so the page still renders, just without that font.
 */
class FetchDataFactory {
  private urls: Record<string, string | null>;
  constructor(o: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    this.urls = { cMapUrl: o.cMapUrl ?? null, standardFontDataUrl: o.standardFontDataUrl ?? null, wasmUrl: o.wasmUrl ?? null };
  }
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const base = this.urls[kind];
    if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const res = await fetch(`${base}${filename}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      console.warn('[pdf] data load failed', filename, String(e));
      throw new Error(`Unable to load ${kind} data: ${filename}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function loadPdf(blob: Blob): Promise<PDFDoc> {
  const data = new Uint8Array(await blob.arrayBuffer());
  // Without the character maps, PDFs with Korean (CID) fonts show garbled or missing text.
  const base = `${location.origin}/pdfjs/`;
  return pdfjs.getDocument({
    data,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    BinaryDataFactory: FetchDataFactory,
  }).promise;
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
