/**
 * animationLoop.js — Smart Grid Sentinel Rendering Engine
 * Source of truth: DESIGN.md v3.3, Sections 6 and 18
 * FROZEN after Phase 1. Extend only — never rewrite.
 *
 * Singleton requestAnimationFrame loop for the entire dashboard.
 * - One rAF loop drives every animated component (no per-component loops).
 * - Page Visibility API: loop pauses completely on hidden tab (battery safe).
 * - FPS cap: 60 FPS on desktop (≥ 768px), 30 FPS on mobile (< 768px).
 * - Reduced-motion: components check their own needs; the loop always runs
 *   but callbacks are responsible for respecting prefers-reduced-motion.
 *
 * Usage:
 *   import { animationLoop } from './animationLoop.js';
 *   animationLoop.subscribe(myCallback);   // myCallback(timestamp)
 *   animationLoop.unsubscribe(myCallback); // call in component destroy()
 */

// ── FPS cap (Section 6 canonical table) ──────────────────────────────────
const IS_MOBILE      = window.matchMedia('(max-width: 767px)').matches;
const FRAME_INTERVAL = IS_MOBILE ? 1000 / 30 : 1000 / 60;  // 33.3ms or 16.7ms

// ── Subscriber registry — Set guarantees O(1) add/delete, no duplicates ──
const subscribers = new Set();

// ── Loop state ────────────────────────────────────────────────────────────
let rafHandle = null;
let lastTick  = 0;
let running   = false;

/**
 * Core tick function.
 * Registered once with requestAnimationFrame — re-queues itself.
 * Applies Page Visibility guard and FPS cap before dispatching to subscribers.
 *
 * @param {DOMHighResTimeStamp} timestamp - provided by rAF
 */
function tick(timestamp) {
  // Always re-queue first so the loop survives even if a subscriber throws.
  rafHandle = requestAnimationFrame(tick);

  // Page Visibility guard — zero CPU on hidden tab (Section 14 requirement).
  if (document.hidden) return;

  // FPS cap guard — skip frame if interval has not elapsed.
  if (timestamp - lastTick < FRAME_INTERVAL) return;
  lastTick = timestamp;

  // Dispatch to all registered subscribers.
  for (const cb of subscribers) {
    try {
      cb(timestamp);
    } catch (err) {
      // Isolate subscriber errors — a broken component must not kill the loop.
      console.error('[animationLoop] subscriber error:', err);
    }
  }
}

/**
 * Start the loop if it is not already running.
 * Called automatically on first subscribe.
 */
function start() {
  if (running) return;
  running   = true;
  lastTick  = 0;
  rafHandle = requestAnimationFrame(tick);
}

/**
 * Stop the loop entirely.
 * Called when all subscribers have been removed.
 */
function stop() {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafHandle);
  rafHandle = null;
}

// ── Page Visibility API integration (Section 14 + Section 18) ────────────
// Pauses the rAF loop while the tab is hidden; resumes when visible.
// This single handler covers every animated component — no per-component
// visibility listeners are needed.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause: cancel the pending frame.
    if (rafHandle !== null) {
      cancelAnimationFrame(rafHandle);
      rafHandle = null;
    }
  } else {
    // Resume: re-enter the tick loop only if we have active subscribers.
    if (running && subscribers.size > 0) {
      lastTick  = 0; // reset delta to avoid a large first-frame skip
      rafHandle = requestAnimationFrame(tick);
    }
  }
});

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Register a callback to be called on each animation frame.
 * The callback receives the DOMHighResTimeStamp provided by rAF.
 * Starts the loop on first subscription.
 *
 * @param {function(DOMHighResTimeStamp): void} callback
 */
function subscribe(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('[animationLoop] subscribe() requires a function');
  }
  subscribers.add(callback);
  start(); // no-op if already running
}

/**
 * Remove a previously registered callback.
 * Stops the loop if no subscribers remain (saves battery).
 * Always call this in component.destroy().
 *
 * @param {function} callback - the same reference passed to subscribe()
 */
function unsubscribe(callback) {
  subscribers.delete(callback);
  if (subscribers.size === 0) {
    stop();
  }
}

/**
 * Read-only snapshot of loop state — useful for debugging.
 * @returns {{ running: boolean, subscriberCount: number, isMobile: boolean, frameInterval: number }}
 */
function getStatus() {
  return {
    running,
    subscriberCount: subscribers.size,
    isMobile:        IS_MOBILE,
    frameInterval:   FRAME_INTERVAL,
  };
}

// ── Named export (DESIGN.md Section 18 mandates this exact export shape) ──
export const animationLoop = {
  subscribe,
  unsubscribe,
  getStatus,      // diagnostic — not part of Section 18 contract but safe to expose
};
