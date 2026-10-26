import { db, type Course, type Doc, type LectureLang } from './db';
import { isNative, LectureAudio } from './native';
import { currentPdf, pageImage, type PDFDoc } from './pdf';

// Common words that are never worth biasing the recogniser towards.
const STOP = new Set(
  `the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what where which while would there their these those then into also each about after again other could first because between through during before under should being both same most still even does done made using used given gives give thus hence since let's lets note example examples proof theorem lemma definition remark corollary proposition section chapter page figure table equation exercise problem solution case cases follows following shown show suppose assume assumption consider recall define defined denote denoted therefore however where whenever every itself value values number numbers function functions result results form general simple order part point points term terms model models method methods data lecture lectures slide slides homework assignment today class week weeks cont continued review midterm final exam quiz chapter introduction summary outline
   moreover furthermore consequently indeed implies imply implied hence holds hold called step steps exists exist satisfies satisfy
   particular arbitrary positive negative zero finite infinite sets set condition conditions property properties similarly clearly
   obviously namely respectively analogously otherwise whereas thereby assume assumed suppose supposed obtain obtained yields`.split(/\s+/),
);
const KO_PARTICLE = /(은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만|에게|까지|부터|이다|입니다|하는|한다|된다|하고)$/;

/** Rank recurring technical-looking words/phrases in lecture text. */
export function extractTerms(text: string, max = 60): string[] {
  const score = new Map<string, number>();
  const bump = (k: string, v: number) => score.set(k, (score.get(k) ?? 0) + v);

  const words = text.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*[A-Za-zÀ-ÿ]/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    if (lw.length < 4 || STOP.has(lw)) continue;
    const capital = /^[A-ZÀ-Ý]/.test(w) && i > 0; // capitalised mid-text → likely a name (Itô, Girsanov)
    bump(capital ? w : lw, (capital ? 2 : 1) * (lw.length >= 7 ? 1.5 : 1) * (/[À-ÿ]/.test(w) ? 2 : 1));
    const next = words[i + 1]?.toLowerCase();
    if (next && next.length >= 4 && !STOP.has(next)) bump(`${capital ? w : lw} ${next}`, 1.2);
  }
  for (const raw of text.match(/[가-힣]{2,}/g) ?? []) {
    const w = raw.replace(KO_PARTICLE, '');
    if (w.length >= 2) bump(w, 1);
  }
  return [...score.entries()]
    .filter(([k, v]) => v >= (k.includes(' ') ? 3 : 2.5))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => k);
}

export async function pdfAllText(pdf: PDFDoc, maxPages = 500): Promise<string> {
  const parts: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return parts.join('\n');
}

/** Extract and cache a document's terms the first time it's opened. */
const TERMS_V = 4; // bump when extraction changes, so saved lists are redone (4: scanned PDFs are read with OCR)

/**
 * A scanned PDF has (almost) no text layer. On the iPad its pages are read with Vision text
 * recognition once (up to 60 pages) and kept on the document, so terms, translation, summaries and
 * AI questions get the page text too.
 */
async function ocrPdf(doc: Doc, pdf: PDFDoc): Promise<string[]> {
  if (doc.ocrPages?.length) return doc.ocrPages;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 60); i++) {
    try {
      pages.push((await LectureAudio.ocrImage({ image: await pageImage(pdf, i) })).text);
    } catch {
      pages.push('');
    }
  }
  await db.docs.update(doc.id, { ocrPages: pages });
  return pages;
}

export async function ensureDocTerms(doc: Doc, pdf: PDFDoc): Promise<string[]> {
  if (doc.ocrPages?.length && currentPdf.doc === pdf) currentPdf.ocr = doc.ocrPages;
  if (doc.terms && doc.termsV === TERMS_V) return doc.terms;
  let text = await pdfAllText(pdf);
  if (isNative && text.replace(/\s/g, '').length < 30 * Math.min(pdf.numPages, 500)) {
    const ocr = await ocrPdf(doc, pdf);
    if (currentPdf.doc === pdf) currentPdf.ocr = ocr;
    text = ocr.join('\n');
  }
  const terms = extractTerms(text);
  await db.docs.update(doc.id, { terms, termsV: TERMS_V });
  return terms;
}

/** This PDF's terms as the user wants them: extracted ones minus those removed, plus those added. */
export function docTerms(doc: Doc | undefined): string[] {
  if (!doc) return [];
  const removed = new Set((doc.termsRemoved ?? []).map((t) => t.toLowerCase()));
  return [...new Set([...(doc.termsAdded ?? []), ...(doc.terms ?? []).filter((t) => !removed.has(t.toLowerCase()))])];
}

/**
 * Hints for the speech recogniser: the course's own terms first, then terms from this PDF,
 * then from the course's other PDFs. Apple recommends keeping this list short (~100).
 */
export async function recognitionVocabulary(docId: string, course: Course | null, _lang: LectureLang): Promise<string[]> {
  const doc = await db.docs.get(docId);
  const siblings = course ? (await db.docs.where('courseId').equals(course.id).toArray()).filter((d) => d.id !== docId) : [];
  const fromSiblings = new Map<string, number>();
  for (const d of siblings) for (const t of docTerms(d)) fromSiblings.set(t, (fromSiblings.get(t) ?? 0) + 1);
  const ordered = [
    ...(course?.vocab ?? []),
    ...docTerms(doc),
    ...[...fromSiblings.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t),
  ];
  return [...new Set(ordered.map((t) => t.trim()).filter(Boolean))].slice(0, 100);
}
