/**
 * historyPoller.js — Smart Grid Sentinel Historical Data Fetcher
 * Phase 5 deliverable. DESIGN.md §12.
 *
 * Fetches historical telemetry from the backend analytics API.
 * On API failure (404, network error, empty response): falls back to
 * synthesizing history from the live telemetryBuffer ring buffers so
 * the Analytics page is always displayable — even without a backend.
 *
 * Cache: identical query parameters return cached data for 30 seconds,
 * preventing redundant requests when multiple charts share a time range.
 *
 * SEPARATION RULE: No document.* calls. No imports from /components or /pages.
 * Pure data layer — fetch, transform, cache, return.
 *
 * Public API:
 *   fetchHistory(field, fromDate, toDate, resolution)
 *     → Promise<Array<{ts: number, value: number}>>
 *
 * API contract (GET /api/history):
 *   ?field={field}&from={isoStart}&to={isoEnd}&resolution={pts}
 *   Response: [{ts: "ISO8601", value: number}, ...]
 *   On empty / 404 / error: returns synthesized buffer data
 */

import { getWaveform } from './telemetryBuffer.js';

// ── Cache ─────────────────────────────────────────────────────────────────
// Key: canonical query string. Value: { data, expiresAt }.
const CACHE_TTL_MS = 30_000;  // 30 seconds
const _cache = new Map();

// ── In-flight request deduplication ──────────────────────────────────────
// Prevents two simultaneous identical fetches (e.g. two charts loading at once).
const _inFlight = new Map();  // cacheKey → Promise<data>

// ── Host resolution ───────────────────────────────────────────────────────
function _apiBase() {
  const host = window.location.host || 'localhost';
  return `http://${host}`;
}

// ── Cache helpers ─────────────────────────────────────────────────────────

function _cacheKey(field, fromDate, toDate, resolution) {
  return `${field}|${fromDate.toISOString()}|${toDate.toISOString()}|${resolution}`;
}

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function _cacheSet(key, data) {
  _cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ── Buffer fallback synthesis ─────────────────────────────────────────────

/**
 * Synthesize history from the live telemetryBuffer waveform data.
 * Used when the backend API is unavailable.
 *
 * The waveform buffer holds up to 120 samples with real timestamps.
 * We return the last 60 entries as a linear time series.
 *
 * @param {string} field — 'v' | 'i' | 't' | 'p'
 * @returns {Array<{ts: number, value: number}>}
 */
function _synthesizeFromBuffer(field) {
  const waveform = getWaveform(field);
  if (waveform.length === 0) {
    // Buffer is also empty — synthesize a flat placeholder so charts render
    return _generatePlaceholderSeries(field);
  }

  // Return last 60 entries (most recent minute of data at 0.5–1 Hz)
  const slice = waveform.slice(-60);
  return slice.map(({ value, timestamp }) => ({ ts: timestamp, value }));
}

/**
 * Generate a minimal flat placeholder series when both API and buffer are empty.
 * Prevents blank / error states on first load.
 *
 * @param {string} field
 * @returns {Array<{ts: number, value: number}>}
 */
function _generatePlaceholderSeries(field) {
  const NOMINAL = { v: 230, i: 12, t: 43, p: 2760 };
  const nominal  = NOMINAL[field] ?? 0;
  const now      = Date.now();
  const count    = 20;

  return Array.from({ length: count }, (_, i) => ({
    ts:    now - (count - i) * 5000,  // 5s intervals, ending now
    value: nominal,
  }));
}

// ── Response normalisation ────────────────────────────────────────────────

/**
 * Normalise the API response array into internal format.
 * API returns [{ts: ISO8601String, value: number}, ...]
 * Internal format: [{ts: epochMs, value: number}, ...]
 *
 * @param {Array} raw
 * @returns {Array<{ts: number, value: number}>}
 */
function _normaliseResponse(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  return raw
    .map(entry => {
      const ts = typeof entry.ts === 'number'
        ? entry.ts
        : new Date(entry.ts).getTime();
      const value = Number(entry.value);
      if (isNaN(ts) || isNaN(value)) return null;
      return { ts, value };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);  // ensure chronological order
}

// ── Core fetch ────────────────────────────────────────────────────────────

/**
 * Fetch historical data for a single field from the backend API.
 *
 * Results are cached for 30 seconds per unique (field, from, to, resolution)
 * combination. Identical in-flight requests are deduplicated via a promise map.
 *
 * Falls back to telemetryBuffer data when:
 *   - The API returns 404 or any non-200 status
 *   - The network request fails
 *   - The response is empty (zero records returned)
 *
 * @param {string} field       — telemetry field: 'v' | 'i' | 't' | 'p'
 * @param {Date}   fromDate    — start of time range
 * @param {Date}   toDate      — end of time range
 * @param {number} [resolution=200] — desired number of data points
 * @returns {Promise<Array<{ts: number, value: number}>>}
 */
export async function fetchHistory(field, fromDate, toDate, resolution = 200) {
  if (!(fromDate instanceof Date) || !(toDate instanceof Date)) {
    throw new TypeError('[historyPoller] fromDate and toDate must be Date instances');
  }
  if (fromDate >= toDate) {
    throw new RangeError('[historyPoller] fromDate must be before toDate');
  }

  const key = _cacheKey(field, fromDate, toDate, resolution);

  // 1. Return cached data if still fresh
  const cached = _cacheGet(key);
  if (cached) return cached;

  // 2. Deduplicate in-flight requests
  if (_inFlight.has(key)) return _inFlight.get(key);

  const fetchPromise = _doFetch(field, fromDate, toDate, resolution, key);
  _inFlight.set(key, fetchPromise);

  try {
    return await fetchPromise;
  } finally {
    _inFlight.delete(key);
  }
}

async function _doFetch(field, fromDate, toDate, resolution, cacheKey) {
  const params = new URLSearchParams({
    field,
    from:       fromDate.toISOString(),
    to:         toDate.toISOString(),
    resolution: String(resolution),
  });

  const url = `${_apiBase()}/api/history?${params}`;

  try {
    const response = await fetch(url, {
      method:  'GET',
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(8000),  // 8s timeout for history queries
    });

    if (response.status === 404 || response.status === 501) {
      // Backend not implemented yet — use buffer fallback silently
      console.info(`[historyPoller] /api/history not available (${response.status}) — using buffer fallback`);
      const fallback = _synthesizeFromBuffer(field);
      _cacheSet(cacheKey, fallback);
      return fallback;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const raw = await response.json();
    const data = _normaliseResponse(raw);

    if (data.length === 0) {
      // Empty response — fall back to buffer
      console.info('[historyPoller] empty response — using buffer fallback');
      const fallback = _synthesizeFromBuffer(field);
      _cacheSet(cacheKey, fallback);
      return fallback;
    }

    _cacheSet(cacheKey, data);
    return data;

  } catch (err) {
    // Network error, timeout, or parse failure
    console.warn(`[historyPoller] fetch failed for ${field}: ${err.message} — using buffer fallback`);
    const fallback = _synthesizeFromBuffer(field);
    // Do not cache errors — allow retry on next call
    return fallback;
  }
}

// ── Cache management utilities (public) ──────────────────────────────────

/**
 * Invalidate all cached history data.
 * Call when the user changes device or explicitly refreshes.
 */
export function clearCache() {
  _cache.clear();
  console.info('[historyPoller] cache cleared');
}

/**
 * Invalidate cache for a specific field only.
 * @param {string} field
 */
export function clearFieldCache(field) {
  for (const key of _cache.keys()) {
    if (key.startsWith(`${field}|`)) {
      _cache.delete(key);
    }
  }
}

/**
 * Fetch history for multiple fields concurrently, sharing the same time range.
 * Returns an object keyed by field name.
 *
 * @param {string[]} fields      — e.g. ['v', 'i', 't', 'p']
 * @param {Date}     fromDate
 * @param {Date}     toDate
 * @param {number}   [resolution=200]
 * @returns {Promise<Record<string, Array<{ts: number, value: number}>>>}
 */
export async function fetchHistoryMulti(fields, fromDate, toDate, resolution = 200) {
  const results = await Promise.allSettled(
    fields.map(f => fetchHistory(f, fromDate, toDate, resolution))
  );

  const out = {};
  for (let i = 0; i < fields.length; i++) {
    const r = results[i];
    out[fields[i]] = r.status === 'fulfilled' ? r.value : _synthesizeFromBuffer(fields[i]);
  }
  return out;
}
