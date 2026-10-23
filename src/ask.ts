import { Clipboard } from '@capacitor/clipboard';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { Segment } from './db';
import { fmtTime } from './ink';
import { isNative } from './native';
import type { Bounds } from './store';

export const QUICK_ASKS = [
  { label: '직관적으로 설명', text: '이 부분이 무슨 뜻인지 직관적으로 설명해줘. 왜 이런 식이 나오는지, 그림이나 비유가 있으면 같이.' },
  { label: '유도 과정', text: '이 식/결과의 유도 과정을 한 단계씩 빠짐없이 보여줘. 각 단계에서 쓰인 정리나 성질도 표시해줘.' },
  { label: '교수님 말 정리', text: '교수님이 이 부분을 설명하면서 한 말을 정리해주고, 내가 놓쳤을 만한 핵심을 짚어줘.' },
  { label: '예시 들어줘', text: '이 개념을 이해할 수 있는 구체적인 예시나 간단한 계산 예제를 하나 보여줘.' },
] as const;

/** Crop a page region (PDF + ink) to a PNG data URL. */
export function cropPage(page: number, b: Bounds, pad = 12): string | null {
  const el = document.querySelector<HTMLElement>(`[data-page="${page}"] .page`);
  if (!el) return null;
  const [pdfCanvas, inkCanvas] = Array.from(el.querySelectorAll('canvas'));
  const width1 = Number(el.dataset.w1);
  const px = pdfCanvas.width / width1; // canvas pixels per PDF unit
  const x = Math.max(0, (b.minX - pad) * px);
  const y = Math.max(0, (b.minY - pad) * px);
  const w = Math.min(pdfCanvas.width - x, (b.maxX - b.minX + pad * 2) * px);
  const h = Math.min(pdfCanvas.height - y, (b.maxY - b.minY + pad * 2) * px);
  if (w < 4 || h < 4) return null;
  const out = document.createElement('canvas');
  out.width = Math.round(w);
  out.height = Math.round(h);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(pdfCanvas, x, y, w, h, 0, 0, out.width, out.height);
  const inkScale = inkCanvas.width / pdfCanvas.width;
  ctx.drawImage(inkCanvas, x * inkScale, y * inkScale, w * inkScale, h * inkScale, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Captions around time t (seconds) — what the professor was saying. */
export function nearbyCaptions(segments: Segment[], recId: string | undefined, t: number | undefined, before = 90, after = 20) {
  if (!recId || t == null) return [];
  return segments.filter((s) => s.recId === recId && s.end >= t - before && s.start <= t + after);
}

export function buildPrompt(opts: {
  question: string;
  hasImage: boolean;
  captions: Segment[];
  focusLine?: string;
  pageText?: string;
  docName: string;
}) {
  const parts = [
    `나는 대학원 수업 "Stochastic Differential Equations"를 듣고 있는 학생이야. 수업은 영어로 진행돼. (강의 자료: ${opts.docName})`,
  ];
  if (opts.hasImage) parts.push('첨부한 이미지는 강의 노트(PDF + 내 필기)에서 내가 표시한 부분이야.');
  if (opts.focusLine) parts.push(`[이해가 안 된 교수님 말]\n"${opts.focusLine}"`);
  parts.push(`[질문]\n${opts.question}`);
  if (opts.captions.length) {
    parts.push(
      '[그때 교수님이 한 말 — 자동 자막이라 오인식이 있을 수 있음]\n' +
        opts.captions.map((c) => `(${fmtTime(c.start)}) ${c.text}`).join('\n'),
    );
  }
  if (opts.pageText) parts.push(`[이 페이지 PDF 텍스트]\n${opts.pageText.slice(0, 2500)}`);
  parts.push('한국어로 답해줘. 수식은 LaTeX로 쓰고, 수학 용어는 영어를 함께 적어줘 (예: 마팅게일(martingale)).');
  return parts.join('\n\n');
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/:(.*?);/)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
export { dataUrlToBlob };

export async function copyText(text: string) {
  if (isNative) await Clipboard.write({ string: text });
  else await navigator.clipboard.writeText(text);
}

export async function copyImage(dataUrl: string) {
  if (isNative) await Clipboard.write({ image: dataUrl });
  else await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(dataUrl) })]);
}

/**
 * Hand the question to the Claude / ChatGPT app via the iOS share sheet (image + text).
 * The prompt is also put on the clipboard in case the receiving app drops the text.
 */
export async function shareQuestion(prompt: string, imageDataUrl?: string) {
  await copyText(prompt).catch(() => {});
  if (isNative) {
    let files: string[] | undefined;
    if (imageDataUrl) {
      const { uri } = await Filesystem.writeFile({
        path: `ask-${Date.now()}.png`,
        data: imageDataUrl.split(',')[1],
        directory: Directory.Cache,
      });
      files = [uri];
    }
    await Share.share({ text: prompt, files });
    return;
  }
  const files = imageDataUrl ? [new File([dataUrlToBlob(imageDataUrl)], 'question.png', { type: 'image/png' })] : [];
  if (navigator.canShare?.({ text: prompt, files })) {
    await navigator.share({ text: prompt, files });
  } else {
    throw new Error('이 브라우저는 공유를 지원하지 않아요. 질문이 클립보드에 복사됐어요.');
  }
}

export const APP_LINKS = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
};

/** Open the Claude / ChatGPT app (universal link) — Capacitor hands external URLs to iOS. */
export function openApp(which: keyof typeof APP_LINKS) {
  const url = APP_LINKS[which];
  if (isNative) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}
