import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface TranscriptEvent {
  text: string;
  start: number; // seconds since recording start
  end: number;
  final: boolean;
}

export type GesturePhase = 'began' | 'changed' | 'ended';

/** A finished PencilKit stroke, in web-view (CSS px) coordinates. */
export interface InkStrokeEvent {
  points: { x: number; y: number; p: number }[];
  startedAt: number;
  data: string; // base64 PKDrawing
  png: string; // base64 PNG of the stroke as PencilKit drew it
  bounds: { x: number; y: number; w: number; h: number };
}

interface LectureAudioPlugin {
  prepare(): Promise<{ mic: boolean; speech: boolean; engine: 'speechanalyzer' | 'sfspeech' }>;
  start(opts: { vocabulary: string[]; locale: string }): Promise<{ engine: string; locale: string }>;
  stop(): Promise<{ uri: string; path: string }>;
  translate(opts: { text: string }): Promise<{ text: string }>;
  pickAudio(): Promise<{ uri: string; path: string; name: string; duration: number; createdAt: number }>;
  transcribeFile(opts: { path: string; vocabulary: string[] }): Promise<{ segments: { text: string; start: number; end: number }[] }>;
  llmStatus(): Promise<{ available: boolean; reason?: string }>;
  llmTranslateLines(opts: { instructions: string; prompt: string; count: number }): Promise<{ lines: string[] }>;
  llmGenerate(opts: { instructions: string; prompt: string }): Promise<{ text: string }>;
  signingInfo(): Promise<{ expires?: number }>;
  setInkPreview(opts: { enabled: boolean; color: string; width: number; highlighter: boolean; area: { x: number; y: number; w: number; h: number } }): Promise<void>;
  clearInkPreview(): Promise<void>;
  renderInk(opts: { items: { id: string; data: string; k: number }[]; pixelRatio: number }): Promise<{ images: Record<string, string> }>;
  addListener(event: 'transcript', fn: (e: TranscriptEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'fileProgress', fn: (e: { seconds: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pencilDoubleTap', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'inkStroke', fn: (e: InkStrokeEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'fingerPan', fn: (e: { state: GesturePhase; dx: number; dy: number; vx: number; vy: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'fingerPinch', fn: (e: { state: GesturePhase; scale: number; x: number; y: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'fingerTap', fn: (e: { x: number; y: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
export const LectureAudio = registerPlugin<LectureAudioPlugin>('LectureAudio');

/** Load a file written by the native side into a Blob. */
export async function nativeFileBlob(uri: string): Promise<Blob> {
  const res = await fetch(Capacitor.convertFileSrc(uri));
  return res.blob();
}
