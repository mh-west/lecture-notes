import Anthropic from '@anthropic-ai/sdk';
import { isNative, LectureAudio } from './native';

// Language-model engines for refined translation and lecture summaries.
// "apple" runs Apple Intelligence on the iPad (free, offline, small model);
// "claude" uses the student's own Anthropic API key (best quality, pay per use).

export type Engine = 'apple' | 'claude';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 — 최고 품질' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 — 균형' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 — 가장 저렴' },
] as const;

export interface LlmSettings {
  engine: Engine;
  claudeKey: string;
  claudeModel: string;
  refine: boolean; // refine captions automatically while recording
}

const DEFAULTS: LlmSettings = { engine: 'apple', claudeKey: '', claudeModel: 'claude-opus-5-5', refine: true };
const KEY = 'llmSettings';

export function loadSettings(): LlmSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: LlmSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: settings last for this session only */
  }
}

/** Why the chosen engine can't run right now, or null when it can. */
export async function engineProblem(s = loadSettings()): Promise<string | null> {
  if (s.engine === 'claude') return s.claudeKey.trim() ? null : '설정에서 Claude API 키를 입력하세요';
  if (!isNative) return '기기 내 AI는 iPad 앱에서만 쓸 수 있어요';
  const st = await LectureAudio.llmStatus();
  return st.available ? null : (st.reason ?? '기기 내 AI를 쓸 수 없어요');
}

/** Slide text the professor is showing, plus the neighbouring slides. */
export interface PageContext {
  page: number;
  current: string;
  prev?: string;
  next?: string;
}

const TRANSLATE_INSTRUCTIONS = `You translate English captions of a university mathematics lecture into natural Korean for a Korean student.
The captions are speech-recognition output: they contain filler words, false starts, repetitions and misheard math terms. The slide text the professor is showing (and the slides before and after it) tells you the topic and the right terms — for example "martindale" means "martingale".
- Remove fillers and false starts. If a line is only filler, leave its translation empty.
- Translate the meaning, not word for word, in concise lecture-note Korean.
- Technical terms: decide like a Korean graduate student taking notes. Keep a term in English when students normally use the English word or the Korean is awkward or ambiguous (e.g. martingale, Brownian motion, filtration, stopping time, quadratic variation, Itô integral). Use Korean for everyday mathematical words (적분, 기댓값, 수렴, 증명, 정리 …). Use the same choice for a term throughout.
- Keep formulas and symbols as they are.
- Return one entry for every caption line, using its number.`;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)} …` : (s ?? ''));

function translatePrompt(lines: string[], ctx: PageContext | null, before: string[], big: boolean) {
  const parts = ['## Captions to translate', ...lines.map((l, i) => `${i + 1}. ${l}`)];
  if (before.length) parts.push('', '## What the professor said just before (context only, do not translate)', ...before);
  if (ctx) {
    parts.push('', `## Slide the professor is showing (page ${ctx.page})`, clip(ctx.current, big ? 4000 : 1800));
    if (ctx.prev) parts.push('', `## Previous slide (page ${ctx.page - 1})`, clip(ctx.prev, big ? 2500 : 600));
    if (ctx.next) parts.push('', `## Next slide (page ${ctx.page + 1})`, clip(ctx.next, big ? 2500 : 600));
  }
  return parts.join('\n');
}

// The small on-device model follows Korean instructions better and otherwise tends to drop content.
const APPLE_TRANSLATE_INSTRUCTIONS = `너는 영어 수학 강의 자막을 한국어로 번역한다.
자막은 음성 인식 결과라서 "uh", "you know", "yeah", "let me say" 같은 군말과 잘못 들린 수학 용어가 섞여 있다. 슬라이드 내용을 보고 올바른 용어로 고친다 (예: martindale → martingale, integrate → 적분하다).
규칙:
- 군말만 지우고, 수학적 내용은 하나도 빠뜨리지 말고 모두 번역한다.
- 한 줄 전체가 군말이면 빈 문자열로 둔다.
- 자연스러운 한국어 강의 노트 문체(~다)로 쓴다. 수식과 기호는 그대로 둔다.
- 전문 용어는 한국 대학원생이 노트할 때처럼 판단한다: martingale, Brownian motion, filtration, stopping time처럼 보통 영어로 쓰는 용어는 영어 그대로 두고, 적분·기댓값·수렴 같은 일반 수학 용어는 한국어로 쓴다.
- 입력 줄마다 번호와 함께 하나씩 돌려준다.`;

/** Natural Korean for each caption line; '' for lines that were only filler. */
export async function translateLines(lines: string[], ctx: PageContext | null, before: string[]): Promise<string[]> {
  const s = loadSettings();
  if (s.engine === 'apple') {
    const prompt = translatePrompt(lines, ctx, before.slice(-2), false);
    const { lines: out } = await LectureAudio.llmTranslateLines({ instructions: APPLE_TRANSLATE_INSTRUCTIONS, prompt, count: lines.length });
    return out;
  }
  const text = await claude(
    `${TRANSLATE_INSTRUCTIONS}\nOutput format: one line per caption, "<number>: <Korean>" (nothing after the colon for filler-only lines). No other text.`,
    translatePrompt(lines, ctx, before, true),
    'low',
  );
  const out = Array<string>(lines.length).fill('');
  for (const row of text.split('\n')) {
    const m = row.match(/^\s*(\d+)\s*[:.]\s?(.*)$/);
    if (m && +m[1] >= 1 && +m[1] <= lines.length) out[+m[1] - 1] = m[2].trim();
  }
  return out;
}

const SUMMARY_INSTRUCTIONS = `You write Korean lecture notes for a student who attended a university mathematics lecture.
You get the lecture transcript (speech recognition, with timestamps, possibly with misheard terms and filler) and the text of the slides that were shown.
Write a summary in Korean, in Markdown:
## 한 줄 요약
## 다룬 내용 (in lecture order; for each part give the time like [12:30] and slide page like p.241, the key definitions/theorems/ideas, and how the argument goes)
## 교수님이 강조한 점
## 복습할 때 확인할 것 (questions or gaps worth checking)
For technical terms, keep the English word where Korean students normally use it (martingale, Brownian motion, filtration …) and use Korean for everyday mathematical words; write every formula in LaTeX: inline as $...$ and displayed equations as $$...$$ on their own line (no \\( \\) or \\[ \\]). Be faithful to what was said; do not invent content that is not in the transcript or slides.`;

/** A Korean Markdown summary of the lecture. `transcript` has one "[mm:ss] text" line per caption. */
export async function summarize(transcript: string, slides: string, onProgress?: (msg: string) => void): Promise<string> {
  const s = loadSettings();
  if (s.engine === 'claude') {
    onProgress?.('Claude가 요약하는 중…');
    return claude(SUMMARY_INSTRUCTIONS, `## Slides\n${clip(slides, 60000)}\n\n## Transcript\n${transcript}`, 'medium');
  }
  // The on-device model sees ~4k tokens at a time: summarise in pieces, then combine.
  // With no lecture audio for the range, summarise the slides themselves.
  const source = transcript.trim() ? transcript : slides;
  const pieces: string[] = [];
  let cur = '';
  for (const line of source.split('\n')) {
    if (cur.length + line.length > 3500 && cur) {
      pieces.push(cur);
      cur = '';
    }
    cur += `${line}\n`;
  }
  if (cur) pieces.push(cur);
  const notes: string[] = [];
  for (const [i, p] of pieces.entries()) {
    onProgress?.(`부분 요약 ${i + 1} / ${pieces.length}`);
    const { text } = await LectureAudio.llmGenerate({
      instructions: 'You summarise part of a mathematics lecture transcript (speech recognition, may contain filler and misheard terms) into short Korean bullet points. Keep the [mm:ss] time of each point. Only include what was actually said.',
      prompt: p,
    });
    notes.push(text);
  }
  onProgress?.('전체 요약 정리 중…');
  const { text } = await LectureAudio.llmGenerate({
    instructions: SUMMARY_INSTRUCTIONS.replace('the lecture transcript (speech recognition, with timestamps, possibly with misheard terms and filler) and the text of the slides that were shown', 'bullet-point notes made from each part of the lecture, in order'),
    prompt: clip(notes.join('\n\n'), 9000),
  });
  return text;
}

async function claude(system: string, user: string, effort: 'low' | 'medium'): Promise<string> {
  const s = loadSettings();
  const client = new Anthropic({ apiKey: s.claudeKey.trim(), dangerouslyAllowBrowser: true });
  // Server-side fallback re-runs a declined request on another model; Haiku has none.
  const fallback = s.claudeModel === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };
  try {
    const res = await client.beta.messages.create({
      model: s.claudeModel,
      max_tokens: 16000,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: user }],
      ...fallback,
    });
    if (res.stop_reason === 'refusal') throw new Error('Claude가 이 요청을 거절했어요');
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude API 키가 올바르지 않아요');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude 요청이 너무 많아요. 잠시 후 다시 시도하세요');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('인터넷에 연결되지 않아 Claude를 쓸 수 없어요');
    // No typed error for an empty balance: it is a 400 whose message mentions the credit balance.
    if (e instanceof Anthropic.BadRequestError && /credit balance/i.test(e.message)) {
      throw new Error('Claude API 크레딧이 떨어졌어요. console.anthropic.com → Billing에서 충전하세요');
    }
    if (e instanceof Anthropic.APIError) throw new Error(`Claude 오류 (${e.status}): ${e.message}`);
    throw e;
  }
}
