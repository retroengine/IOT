/**
 * telemetryBuffer.js — Smart Grid Sentinel Telemetry Buffer
 * Source of truth: DESIGN.md v3.3, Sections 7 and 18
 *
 * Fixed-size circular (ring) buffers for waveform and sparkline data.
 * The buffer layer sits between the telemetry poller and the rendering
 * components. Components read from it; the poller writes to it.
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 *
 * Public API:
 *   push(field, value, timestamp)  — write one sample
 *   getWaveform(field)             → Array<{value, timestamp}> (max 120)
 *   getSparkline(field)            → number[] (max 60)
 *   clear()                        — reset all buffers
 *
 * Buffer sizes (DESIGN.md §7 — Telemetry Buffer Sizes):
 *   WAVEFORM_BUFFER_SIZE  = 120  (~12 s at 10 Hz)
 *   SPARKLINE_BUFFER_SIZE =  60  (~120 s at 0.5 Hz)
 */

// ── Buffer size constants (DESIGN.md §7) ─────────────────────────────────
// Components MUST import these — never hardcode their own buffer size.
export const WAVEFORM_BUFFER_SIZE  = 120;  // ~12s at 10Hz
export const SPARKLINE_BUFFER_SIZE =  60;  // ~120s at 0.5Hz

// ── Fields tracked (Phase 2: voltage, current, temperature, power) ────────
// Extend this set in later phases if additional fields need buffering.
const TRACKED_FIELDS = ['v', 'i', 't', 'p'];

// ── CircularBuffer ─────────────────────────────────────────────────────────
/**
 * A fixed-capacity circular (ring) buffer.
 * When full, the oldest item is overwritten by the newest.
 *
 * Stores items of any type (numbers, objects).
 * O(1) push. O(n) read (toArray rebuilds ordered slice each call).
 * For a 120-element buffer at 10 Hz this is negligible cost.
 *
 * @template T
 */
class CircularBuffer {
  /**
   * @param {number} capacity — maximum number of items
   */
  constructor(capacity) {
    this._cap  = capacity;
    this._data = new Array(capacity); // pre-allocated fixed array
    this._head = 0;   // index of the NEXT write position
    this._size = 0;   // number of valid items (≤ capacity)
  }

  /**
   * Add an item. If the buffer is full, the oldest item is replaced.
   * @param {T} item
   */
  push(item) {
    this._data[this._head] = item;
    this._head = (this._head + 1) % this._cap;
    if (this._size < this._cap) {
      this._size++;
    }
    // When at capacity, _head now points to the oldest slot (it was just overwritten).
    // No explicit oldest-pointer needed — tail = _head when full.
  }

  /**
   * Return all valid items in chronological order (oldest first).
   * @returns {T[]}
   */
  toArray() {
    if (this._size === 0) return [];

    if (this._size < this._cap) {
      // Buffer not yet full — data lives in [0 .. _size-1], no wrapping.
      return this._data.slice(0, this._size);
    }

    // Buffer is full. Oldest element is at _head; newest is at _head - 1.
    // Reconstruct chronological order by stitching the two halves.
    const tail = this._head; // first (oldest) element
    return [
      ...this._data.slice(tail),        // oldest → end of array
      ...this._data.slice(0, tail),     // start of array → newest
    ];
  }

  /**
   * Return the last N items (newest N) in chronological order.
   * @param {number} n
   * @returns {T[]}
   */
  tail(n) {
    const all = this.toArray();
    return all.slice(-n);
  }

  /** Number of valid items currently held. */
  get length() { return this._size; }

  /** Reset to empty. */
  clear() {
    this._head = 0;
    this._size = 0;
    // Do not reallocate — reuse the pre-allocated array.
  }
}

// ── Buffer registry ───────────────────────────────────────────────────────
// Two independent buffer sets per tracked field:
//   waveform  — large, stores {value, timestamp} objects at 10 Hz
//   sparkline — smaller, stores plain numbers at 0.5–1 Hz
//
// Using plain objects (not Map) so the structure is clearly enumerable
// for debugging.

const _waveformBuffers  = {};
const _sparklineBuffers = {};

for (const field of TRACKED_FIELDS) {
  _waveformBuffers[field]  = new CircularBuffer(WAVEFORM_BUFFER_SIZE);
  _sparklineBuffers[field] = new CircularBuffer(SPARKLINE_BUFFER_SIZE);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Push a new sample into both the waveform and sparkline buffers for a field.
 *
 * Called by telemetryPoller on every incoming frame for tracked fields.
 * The caller decides which buffer a value belongs to based on the field's
 * update rate (10 Hz → waveform, ≤ 1 Hz → sparkline). In practice both
 * buffers receive every push and the sparkline simply captures a lower-rate
 * view of the same data (it fills more slowly but never overflows above 60).
 *
 * @param {string} field     — field key: 'v' | 'i' | 't' | 'p'
 * @param {number} value     — the measured value
 * @param {number} [timestamp=Date.now()] — epoch milliseconds
 */
export function push(field, value, timestamp = Date.now()) {
  if (!TRACKED_FIELDS.includes(field)) {
    // Silently ignore unknown fields — forward-compatible.
    return;
  }
  if (typeof value !== 'number' || !isFinite(value)) {
    // Guard against NaN / Infinity from the parser.
    return;
  }

  const entry = { value, timestamp };
  _waveformBuffers[field].push(entry);
  _sparklineBuffers[field].push(value); // sparkline stores raw numbers
}

/**
 * Get the waveform buffer for a field as an ordered array.
 *
 * Returns up to WAVEFORM_BUFFER_SIZE items, oldest first.
 * Used by waveformCard.js and canvasEngine.drawWaveform().
 *
 * @param {string} field — 'v' | 'i' | 't' | 'p'
 * @returns {Array<{value: number, timestamp: number}>}
 */
export function getWaveform(field) {
  if (!_waveformBuffers[field]) return [];
  return _waveformBuffers[field].toArray();
}

/**
 * Get the sparkline buffer for a field as a plain number array.
 *
 * Returns up to SPARKLINE_BUFFER_SIZE items, oldest first.
 * Used by sparkline.js and canvasEngine.drawSparkline().
 *
 * @param {string} field — 'v' | 'i' | 't' | 'p'
 * @returns {number[]}
 */
export function getSparkline(field) {
  if (!_sparklineBuffers[field]) return [];
  return _sparklineBuffers[field].toArray();
}

/**
 * Reset all buffers to empty.
 *
 * Called on explicit user logout or device reset.
 * Per DESIGN.md §7: buffers are NOT cleared on WebSocket reconnect —
 * stale data is preferable to a blank waveform during the reconnect window.
 */
export function clear() {
  for (const field of TRACKED_FIELDS) {
    _waveformBuffers[field].clear();
    _sparklineBuffers[field].clear();
  }
}

/**
 * Diagnostic: return the current fill level of all buffers.
 * Used by performanceMonitor.js in Phase 10.
 * @returns {object}
 */
export function getBufferStatus() {
  const status = {};
  for (const field of TRACKED_FIELDS) {
    status[field] = {
      waveform:  _waveformBuffers[field].length,
      sparkline: _sparklineBuffers[field].length,
    };
  }
  return status;
}
