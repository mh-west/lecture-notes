// Finger gestures on the pages. The page canvases use touch-action: none (so the pencil isn't held back),
// which means scrolling, flinging and pinch-zoom are done here by hand.

/** PencilKit strokes handed to the page whose native copy should go once the page has drawn them. */
export const nativeStrokes = new Set<string>();

/** True while two fingers are pinching; one-finger panning pauses meanwhile. */
export let pinching = false;
export const setPinching = (v: boolean) => {
  pinching = v;
};

// Fling after a finger scroll: keep moving and slow down, like native scrolling.
let inertiaFrame = 0;
export function stopInertia() {
  cancelAnimationFrame(inertiaFrame);
  inertiaFrame = 0;
}
/** vx, vy: scroll speed in px/ms at release. */
export function startInertia(el: HTMLElement, vx: number, vy: number) {
  stopInertia();
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(32, now - last);
    last = now;
    el.scrollLeft += vx * dt;
    el.scrollTop += vy * dt;
    const decay = Math.pow(0.995, dt);
    vx *= decay;
    vy *= decay;
    inertiaFrame = Math.abs(vx) + Math.abs(vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  inertiaFrame = requestAnimationFrame(step);
}
