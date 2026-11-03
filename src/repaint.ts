import { App as CapApp } from '@capacitor/app';
import { useSyncExternalStore } from 'react';

// When the app comes back on screen (relaunch, back from another app, unlock), iPad WebKit may have
// thrown away canvas contents and missed visibility changes while it was away. Pages listen to this
// counter to check their visibility again and redraw.

let gen = 0;
const listeners = new Set<() => void>();
let last = 0;
function bump() {
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - last < 300) return; // resume and visibilitychange arrive together
  last = now;
  gen++;
  listeners.forEach((fn) => fn());
}
document.addEventListener('visibilitychange', bump);
window.addEventListener('pageshow', bump);
CapApp.addListener('resume', bump).catch(() => {});

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const useRepaint = () => useSyncExternalStore(subscribe, () => gen);
