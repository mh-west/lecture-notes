import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface TranscriptEvent {
  text: string;
  start: number; // seconds since recording start
  end: number;
  final: boolean;
}

interface LectureAudioPlugin {
  prepare(): Promise<{ mic: boolean; speech: boolean; engine: 'speechanalyzer' | 'sfspeech' }>;
  start(opts: { vocabulary: string[] }): Promise<{ engine: string }>;
  stop(): Promise<{ uri: string; path: string }>;
  translate(opts: { text: string }): Promise<{ text: string }>;
  addListener(event: 'transcript', fn: (e: TranscriptEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', fn: (e: { message: string }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
export const LectureAudio = registerPlugin<LectureAudioPlugin>('LectureAudio');

/** Load a file written by the native side into a Blob. */
export async function nativeFileBlob(uri: string): Promise<Blob> {
  const res = await fetch(Capacitor.convertFileSrc(uri));
  return res.blob();
}
