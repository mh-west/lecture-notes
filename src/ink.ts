import { getStroke } from 'perfect-freehand';
import type { Point, Stroke } from './db';

type Drawable = Pick<Stroke, 'tool' | 'color' | 'size' | 'points'>;

function outlinePath(points: number[][]): Path2D {
  const path = new Path2D();
  if (points.length < 2) return path;
  path.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Drawable, scale: number, last = true) {
  const pts = s.points.map((p) => [p.x * scale, p.y * scale, p.p]);
  const hl = s.tool === 'highlighter';
  const outline = getStroke(pts, {
    size: s.size * scale * (hl ? 4 : 1),
    thinning: hl ? 0 : 0.55,
    smoothing: 0.5,
    streamline: 0.4,
    simulatePressure: !s.points.some((p) => p.p !== 0.5),
    last,
  });
  ctx.save();
  ctx.fillStyle = s.color;
  if (hl) {
    ctx.globalAlpha = 0.3;
    ctx.globalCompositeOperation = 'multiply';
  }
  ctx.fill(outlinePath(outline));
  ctx.restore();
}

function distToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function hitStroke(s: Stroke, p: Point, radius: number): boolean {
  const r = radius + s.size / 2;
  if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) < r;
  for (let i = 1; i < s.points.length; i++) {
    if (distToSegment(p, s.points[i - 1], s.points[i]) < r) return true;
  }
  return false;
}

export function strokeBounds(s: Stroke) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

export interface StrokeGroup {
  index: number; // 1-based order within the doc
  page: number;
  recId?: string;
  t?: number;
  createdAt: number;
  strokeIds: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Strokes drawn within `gapMs` of each other on the same page form one "thought" group. */
export function groupStrokes(strokes: Stroke[], gapMs = 3000): StrokeGroup[] {
  const sorted = [...strokes].sort((a, b) => a.createdAt - b.createdAt);
  const groups: StrokeGroup[] = [];
  let lastAt = -Infinity;
  for (const s of sorted) {
    const b = strokeBounds(s);
    const g = groups[groups.length - 1];
    if (g && g.page === s.page && s.createdAt - lastAt < gapMs) {
      g.strokeIds.push(s.id);
      g.bounds = {
        minX: Math.min(g.bounds.minX, b.minX), minY: Math.min(g.bounds.minY, b.minY),
        maxX: Math.max(g.bounds.maxX, b.maxX), maxY: Math.max(g.bounds.maxY, b.maxY),
      };
    } else {
      groups.push({
        index: groups.length + 1, page: s.page, recId: s.recId, t: s.t,
        createdAt: s.createdAt, strokeIds: [s.id], bounds: b,
      });
    }
    lastAt = s.createdAt;
  }
  return groups;
}

export function fmtTime(sec: number) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
