import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { PDFDocument } from 'pdf-lib';
import { blankSize, db, type Stroke } from './db';
import { drawStroke } from './ink';
import { isNative, LectureAudio } from './native';
import { loadPdf } from './pdf';

// Sharing a lecture PDF out of the app: either the file as it was imported, or with the handwriting on it.
// The handwritten version keeps the original pages (text stays sharp and selectable) in the app's page
// order, with blank pages added, and lays each page's ink over it as a transparent image.

const INK_SCALE = 3; // image px per PDF unit (~216 dpi)

/** Images PencilKit renders for Apple Pencil strokes, so they look exactly as on screen. */
async function pencilImages(strokes: Stroke[]): Promise<Map<string, HTMLImageElement>> {
  const out = new Map<string, HTMLImageElement>();
  const pk = strokes.filter((s) => s.pk);
  if (!isNative || !pk.length) return out;
  for (let i = 0; i < pk.length; i += 40) {
    const batch = pk.slice(i, i + 40);
    try {
      const { images } = await LectureAudio.renderInk({
        items: batch.map((s) => ({ id: s.id, data: s.pk!.data, k: INK_SCALE / s.pk!.scale })),
        pixelRatio: 1,
      });
      for (const [id, png] of Object.entries(images)) {
        const img = new Image();
        img.src = `data:image/png;base64,${png}`;
        await img.decode().catch(() => {});
        out.set(id, img);
      }
    } catch {
      /* drawn from the stroke points instead */
    }
  }
  return out;
}

function inkPng(strokes: Stroke[], w: number, h: number, images: Map<string, HTMLImageElement>, background?: HTMLCanvasElement) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * INK_SCALE);
  c.height = Math.round(h * INK_SCALE);
  const ctx = c.getContext('2d')!;
  if (background) ctx.drawImage(background, 0, 0, c.width, c.height);
  const sorted = [...strokes].sort((a, b) => a.createdAt - b.createdAt);
  for (const s of sorted) {
    const img = images.get(s.id);
    if (img && s.pk) {
      const b = s.pk.bounds;
      ctx.drawImage(img, b.x * INK_SCALE, b.y * INK_SCALE, b.w * INK_SCALE, b.h * INK_SCALE);
    } else {
      drawStroke(ctx, s, INK_SCALE);
    }
  }
  return new Promise<Uint8Array>((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('이미지를 만들지 못했어요'))), 'image/png'),
  );
}

/** The PDF with its handwriting, in the order shown in the app. */
async function withInk(docId: string, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const rec = await db.docs.get(docId);
  if (!rec) throw new Error('문서를 찾을 수 없어요');
  const bytes = new Uint8Array(await rec.pdf.arrayBuffer());
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const view = await loadPdf(rec.pdf); // page sizes as the app shows them, and rendering for rotated pages
  const strokes = await db.strokes.where('docId').equals(docId).toArray();
  const byPage = new Map<number, Stroke[]>();
  for (const s of strokes) byPage.set(s.page, [...(byPage.get(s.page) ?? []), s]);
  const images = await pencilImages(strokes);

  const order = rec.pages?.length ? rec.pages.filter((k) => k < 0 || k <= src.getPageCount()) : src.getPageIndices().map((i) => i + 1);
  const out = await PDFDocument.create();
  const first = (await view.getPage(1)).getViewport({ scale: 1 });
  try {
    for (const [i, key] of order.entries()) {
      onProgress?.(i, order.length);
      const ink = byPage.get(key) ?? [];
      if (key < 0) {
        // Blank page: sized like in the app (as wide as the first page, portrait or landscape).
        const { w, h } = blankSize({ w: first.width, h: first.height }, rec.blankOrient?.[key]);
        const page = out.addPage([w, h]);
        if (ink.length) page.drawImage(await out.embedPng(await inkPng(ink, w, h, images)), { x: 0, y: 0, width: w, height: h });
        continue;
      }
      const vp = (await view.getPage(key)).getViewport({ scale: 1 });
      const [page] = await out.copyPages(src, [key - 1]);
      const rotation = ((page.getRotation().angle % 360) + 360) % 360;
      if (!ink.length) {
        out.addPage(page);
      } else if (rotation === 0) {
        out.addPage(page);
        const box = page.getCropBox();
        page.drawImage(await out.embedPng(await inkPng(ink, vp.width, vp.height, images)), { x: box.x, y: box.y, width: box.width, height: box.height });
      } else {
        // A rotated page: ink coordinates follow the rotated view, so flatten that page into one image.
        const pv = await view.getPage(key);
        const bg = document.createElement('canvas');
        const v2 = pv.getViewport({ scale: INK_SCALE });
        bg.width = Math.round(v2.width);
        bg.height = Math.round(v2.height);
        await pv.render({ canvas: bg, canvasContext: bg.getContext('2d')!, viewport: v2 }).promise;
        const flat = out.addPage([vp.width, vp.height]);
        flat.drawImage(await out.embedPng(await inkPng(ink, vp.width, vp.height, images, bg)), { x: 0, y: 0, width: vp.width, height: vp.height });
      }
    }
  } finally {
    view.loadingTask.destroy();
  }
  onProgress?.(order.length, order.length);
  return out.save();
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const safeName = (name: string) => name.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').trim() || '강의노트';

/** Shares (iPad/Mac app) or downloads (browser) the PDF, with or without the handwriting. */
export async function sharePdf(docId: string, ink: boolean, onProgress?: (done: number, total: number) => void) {
  const rec = await db.docs.get(docId);
  if (!rec) throw new Error('문서를 찾을 수 없어요');
  const bytes = ink ? await withInk(docId, onProgress) : new Uint8Array(await rec.pdf.arrayBuffer());
  const name = `${safeName(rec.name)}${ink ? ' (필기)' : ''}.pdf`;
  if (isNative) {
    const { uri } = await Filesystem.writeFile({ path: name, data: toBase64(bytes), directory: Directory.Cache });
    await Share.share({ title: name, files: [uri] });
  } else {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
