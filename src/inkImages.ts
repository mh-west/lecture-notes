import type { Stroke } from './db';
import { drawStroke } from './ink';
import { LectureAudio } from './native';

// PencilKit strokes are shown as images PencilKit rendered, so they look exactly as they did while being
// written. Images are kept per stroke at the zoom they were made for; other zooms are rendered on demand.

type Img = { scale: number; img: HTMLImageElement };
const cache = new Map<string, Img[]>();
const requested = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

/** Bumped whenever new images arrive, so pages redraw. */
export const inkVersion = () => version;
export function onInkImages(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export async function addInkImage(id: string, scale: number, png: string) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode().catch(() => {});
  cache.set(id, [...(cache.get(id) ?? []).filter((x) => x.scale !== scale), { scale, img }]);
}

function best(id: string, scale: number): Img | undefined {
  const all = cache.get(id);
  if (!all?.length) return undefined;
  return all.reduce((a, b) => (Math.abs(Math.log(b.scale / scale)) < Math.abs(Math.log(a.scale / scale)) ? b : a));
}

const key = (id: string, scale: number) => `${id}@${scale.toFixed(2)}`;
let queue: { s: Stroke; scale: number }[] = [];
let flushTimer = 0;

function request(s: Stroke, scale: number) {
  if (requested.has(key(s.id, scale))) return;
  requested.add(key(s.id, scale));
  queue.push({ s, scale });
  if (!flushTimer) flushTimer = window.setTimeout(flush, 30);
}

async function flush() {
  flushTimer = 0;
  const batch = queue;
  queue = [];
  const byScale = new Map<number, Stroke[]>();
  for (const { s, scale } of batch) byScale.set(scale, [...(byScale.get(scale) ?? []), s]);
  for (const [scale, strokes] of byScale) {
    try {
      const { images } = await LectureAudio.renderInk({
        items: strokes.map((s) => ({ id: s.id, data: s.pk!.data, k: scale / s.pk!.scale })),
        pixelRatio: Math.min(window.devicePixelRatio || 1, 3),
      });
      await Promise.all(Object.entries(images).map(([id, png]) => addInkImage(id, scale, png)));
    } catch {
      /* not on the iPad, or a broken drawing: the fallback rendering stays */
    }
  }
  version++;
  listeners.forEach((fn) => fn());
}

/** Draw a stroke at `scale` (CSS px per PDF unit); PencilKit strokes use their image when there is one. */
export function paintStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number) {
  if (!s.pk) return drawStroke(ctx, s, scale);
  const hit = best(s.id, scale);
  // Within ~15% the existing image is sharp enough; otherwise ask PencilKit for one at this zoom.
  if (!hit || Math.abs(Math.log(hit.scale / scale)) > 0.15) request(s, +scale.toFixed(2));
  const b = s.pk.bounds;
  if (hit) ctx.drawImage(hit.img, b.x * scale, b.y * scale, b.w * scale, b.h * scale);
  else drawStroke(ctx, s, scale);
}
