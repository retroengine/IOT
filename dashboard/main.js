/**
 * main.js — Smart Grid Sentinel Router & Telemetry Bootstrap
 * Phase 4 deliverable. DESIGN.md §8, §13.
 *
 * Responsibilities:
 *   - Page routing: one active page at a time, destroy on switch
 *   - Telemetry: connect poller (or mock), feed active page via update()
 *   - Buffer feeding: pushes to telemetryBuffer in DEV_MODE so sparklines work
 *
 * Public API (also attached to window for console debugging):
 *   mountPage(name)       — navigate to a named page
 *   getCurrentPage()      — returns the active page instance | null
 *
 * DEV_MODE is auto-detected: enabled on localhost / 127.0.0.1 / file://
 * Set to false (or serve from ESP32 IP) for production.
 *
 * Phase 4 note: Only Page1Status is implemented. All other pages use _NullPage
 * (no-op stub) — they will be replaced in Phases 5–7.
 */

import * as telemetryPoller                   from './telemetry/telemetryPoller.js';
import { startMockPoller, stopMockPoller }    from './telemetry/mockData.js';
import { push as bufferPush }                 from './telemetry/telemetryBuffer.js';
import { Page1Status }      from './pages/page1-status.js';
import { Page2Faults }      from './pages/page2-faults.js';
import { Page3Diagnostics } from './pages/page3-diagnostics.js?v=5'; 
import { Page4Cloud }       from './pages/page4-cloud.js?v=5';       
import { Page5Analytics }   from './pages/page5-analytics.js?v=5';

// ── Dev mode detection ────────────────────────────────────────────────────
// Automatically true on localhost / file:// so the dashboard works immediately
// with mock data without any manual toggle. Set FORCE_DEV_MODE = true to
// override in non-standard dev setups.
const FORCE_DEV_MODE = false;  // override if needed
const DEV_MODE = FORCE_DEV_MODE || (
  window.location.hostname === 'localhost'  ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === ''           ||  // file:// origin
  window.location.protocol  === 'file:'
);

if (DEV_MODE) {
  console.info('[main] DEV_MODE active — using mock telemetry (mockData.js)');
}
class _NullPage {
  mount(containerEl)    { /* leave phase placeholder divs intact */ }
  update(telemetryData) { /* no-op */ }
  destroy()             { /* nothing to clean up */ }
}
// ── Page registry ─────────────────────────────────────────────────────────
// Maps data-page attribute values to Page class constructors.
// Pages not yet implemented are registered as _NullPage (no-op stub).
const PAGE_REGISTRY = {
  status:      Page1Status,    
  faults:      Page2Faults,    
  diagnostics: Page3Diagnostics, // Changed from _NullPage
  cloud:       Page4Cloud,       // Changed from _NullPage
  analytics:   Page5Analytics, 
};

// ── Router state ──────────────────────────────────────────────────────────
let _activePage     = null;  // current Page instance
let _activePageName = null;  // current page name string
let _unsubPoller    = null;  // onMessage unsubscribe fn (real mode only)

// ══════════════════════════════════════════════════════════════════════════
// mountPage
// ══════════════════════════════════════════════════════════════════════════

/**
 * Navigate to a page by name.
 * Destroys the current page (all component subscriptions cleaned up),
 * then instantiates and mounts the new one.
 *
 * Safe to call on the currently active page — acts as a no-op in that case.
 *
 * @param {string} name — matches the data-page attribute on a .nav__link
 *                        e.g. 'status', 'faults', 'diagnostics'
 */
export function mountPage(name) {
  // No-op if already on this page (guard against double-click spam)
  if (name === _activePageName && _activePage !== null) return;

  // ── 1. Destroy current page ──────────────────────────────────────────
  if (_activePage) {
    try {
      _activePage.destroy();
    } catch (err) {
      console.error('[main] page.destroy() error:', err);
    }
    _activePage = null;
  }

  // ── 2. Swap visible page containers ─────────────────────────────────
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));

  const container = document.getElementById(`page-${name}`);
  if (!container) {
    console.warn(`[main] mountPage: no container #page-${name} found`);
    return;
  }
  container.classList.add('active');

  // ── 3. Update nav link active state & ARIA attributes ───────────────
  document.querySelectorAll('.nav__link[data-page]').forEach(el => {
    const isActive = el.dataset.page === name;
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  _activePageName = name;

  // ── 4. Instantiate and mount new page ────────────────────────────────
  const PageClass = PAGE_REGISTRY[name];
  if (!PageClass) {
    console.warn(`[main] mountPage: no page class registered for '${name}'`);
    return;
  }

  try {
    _activePage = new PageClass();
    _activePage.mount(container);
  } catch (err) {
    console.error(`[main] page.mount() error (${name}):`, err);
    _activePage = null;
    return;
  }

  // ── 5. Hydrate with last known data (no blank-flash on tab switch) ───
  if (!DEV_MODE) {
    const latest = telemetryPoller.getLatest();
    if (latest) {
      try { _activePage.update(latest); } catch (err) {
        console.error('[main] initial page.update() error:', err);
      }
    }
  }
}

// ── getCurrentPage ────────────────────────────────────────────────────────
/**
 * Return the currently active page instance, or null if no page is mounted.
 * Useful for debugging in the browser console.
 * @returns {object|null}
 */
export function getCurrentPage() {
  return _activePage;
}

// ══════════════════════════════════════════════════════════════════════════
// Tab router
// ══════════════════════════════════════════════════════════════════════════

function _initRouter() {
  document.querySelectorAll('.nav__link[data-page]').forEach(link => {
    link.addEventListener('click', evt => {
      evt.preventDefault();
      const name = link.dataset.page;
      if (name) mountPage(name);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Telemetry bootstrap
// ══════════════════════════════════════════════════════════════════════════

function _initTelemetry() {
  if (DEV_MODE) {
    // ── Mock mode ──────────────────────────────────────────────────────
    // startMockPoller fires the callback at 500ms intervals with realistic
    // simulated telemetry. We must manually push to telemetryBuffer here
    // because the real telemetryPoller._processFrame() normally does that —
    // mockData bypasses the parser pipeline.
    startMockPoller(500, (data) => {
      const ts = data.ts ?? Date.now();

      // Feed the shared telemetry ring buffers (for waveform / sparkline)
      if (data.v != null) bufferPush('v', data.v, ts);
      if (data.i != null) bufferPush('i', data.i, ts);
      if (data.t != null) bufferPush('t', data.t, ts);
      if (data.p != null) bufferPush('p', data.p, ts);

      // Deliver to active page
      if (_activePage) {
        try { _activePage.update(data); } catch (err) {
          console.error('[main] page.update() error:', err);
        }
      }
    });

  } else {
    // ── Real mode ──────────────────────────────────────────────────────
    // telemetryPoller handles WS → HTTP fallback automatically.
    // Buffer pushing is done internally by _processFrame().

    _unsubPoller = telemetryPoller.onMessage(data => {
      if (_activePage) {
        try { _activePage.update(data); } catch (err) {
          console.error('[main] page.update() error:', err);
        }
      }
    });

    telemetryPoller.onStateChange((state, detail) => {
      console.info('[main] poller:', state, detail);
      // Future: update connectivity indicator in Zone 1
    });

    telemetryPoller.connect('10.177.189.199');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bootstrap on DOMContentLoaded
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  _initRouter();
  mountPage('status');   // mount initial page before telemetry starts
  _initTelemetry();      // begin data flow
});

// ── Expose on window for browser console debugging ────────────────────────
window.mountPage      = mountPage;
window.getCurrentPage = getCurrentPage;

// ══════════════════════════════════════════════════════════════════════════
// _NullPage — placeholder for unimplemented pages
// ══════════════════════════════════════════════════════════════════════════

/**
 * No-op page class. Leaves existing .zone-placeholder content untouched.
 * Replaced by a real page class when the phase is implemented.
 */

