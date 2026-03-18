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
 * dashboard_ip additions (not present in shared / remote variant):
 *   _initFetchInterceptor() — patches window.fetch to inject X-API-Key on
 *                             every same-origin request. Covers relayToggle,
 *                             alarmLog, page2 reset, page3 config, historyPoller,
 *                             and telemetryPoller HTTP fallback — no component
 *                             file needs touching.
 *   _showKeyBanner()        — one-time fixed banner prompting for the API key
 *                             if none is stored in localStorage.
 */

import * as telemetryPoller                   from './telemetry/telemetryPoller.js';
import { startMockPoller, stopMockPoller }    from './telemetry/mockData.js';
import { push as bufferPush }                 from './telemetry/telemetryBuffer.js';
import { Page1Status }      from './pages/page1-status.js';
import { Page2Faults }      from './pages/page2-faults.js';
import { Page3Diagnostics } from './pages/page3-diagnostics.js?v=5';
import { Page4Cloud }       from './pages/page4-cloud.js?v=5';
import { Page5Analytics }   from './pages/page5-analytics.js?v=5';
import { getKey, setKey, isConfigured } from './utils/apiAuth.js';

// ── Dev mode detection ────────────────────────────────────────────────────
// Automatically true on localhost / file:// so the dashboard works immediately
// with mock data without any manual toggle. Set FORCE_DEV_MODE = true to
// override in non-standard dev setups.
const FORCE_DEV_MODE = false;  // override if needed

// DEV_MODE auto-detection:
//   localhost:3000 → relay server is running → use REAL telemetry (not mock)
//   localhost on any other port / file:// → dev mock mode
const _isRelayServer =
  window.location.hostname === 'localhost' &&
  window.location.port === '3000';

const DEV_MODE = FORCE_DEV_MODE || (
  !_isRelayServer && (
    window.location.hostname === 'localhost'  ||
    window.location.hostname === '127.0.0.1' ||
    window.location.hostname === ''           ||  // file:// origin
    window.location.protocol  === 'file:'
  )
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
  diagnostics: Page3Diagnostics,
  cloud:       Page4Cloud,
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
// Fetch interceptor — dashboard_ip only
// Injects X-API-Key on every same-origin fetch() call.
// Covers: relayToggle, alarmLog, page2 /api/reset, page3 /api/config,
//         historyPoller /api/history, telemetryPoller HTTP fallback.
// No component or page file needs to import apiAuth directly.
// ══════════════════════════════════════════════════════════════════════════

function _initFetchInterceptor() {
  const _origFetch = window.fetch.bind(window);

  window.fetch = function (input, init = {}) {
    const urlStr = (input instanceof Request) ? input.url : String(input);

    // Only inject on same-origin requests (device IP) — never on external URLs.
    // A URL is same-origin if it is relative ('/api/…') or explicitly matches
    // the current origin (http://192.168.x.x/…).
    const isSameOrigin =
      urlStr.startsWith('/') ||
      urlStr.startsWith(window.location.origin);

    const key = getKey();

    if (isSameOrigin && key) {
      // Merge headers without mutating the caller's object
      const merged = new Headers(
        init.headers || (input instanceof Request ? input.headers : {})
      );
      merged.set('X-API-Key', key);
      init = { ...init, headers: merged };
    }

    return _origFetch(input, init);
  };

  console.info('[main] fetch interceptor active — X-API-Key injected on same-origin requests');
}

// ══════════════════════════════════════════════════════════════════════════
// First-run key banner — dashboard_ip only
// Shows a small fixed banner at the bottom of the screen when no API key
// is stored. Dismissed permanently once a key is entered.
// ══════════════════════════════════════════════════════════════════════════

function _showKeyBanner() {
  if (isConfigured()) return; // already set — nothing to show

  const banner = document.createElement('div');
  banner.id = 'sgs-key-banner';
  banner.style.cssText = [
    'position: fixed',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'z-index: 9999',
    'background: #131613',
    'border-top: 1px solid rgba(255,255,255,0.12)',
    'padding: 12px 24px',
    'display: flex',
    'align-items: center',
    'gap: 12px',
    'font-family: var(--font-primary, system-ui)',
    'font-size: 13px',
    'color: #8a8e8a',
  ].join(';');

  banner.innerHTML = `
    <span style="flex:1">
      Enter your <strong style="color:#e8ebe5">X-API-Key</strong>
      to enable relay control and alarm acknowledgement.
    </span>
    <input id="sgs-key-input" type="password"
      placeholder="Paste API key…"
      autocomplete="off" spellcheck="false"
      style="background:#0d0f0d;border:1px solid rgba(255,255,255,0.12);
             border-radius:8px;color:#e8ebe5;font-size:13px;
             padding:6px 12px;outline:none;width:220px;" />
    <button id="sgs-key-save"
      style="background:#1D9E75;color:#060f06;border:none;border-radius:8px;
             padding:7px 18px;font-size:13px;font-weight:500;cursor:pointer;">
      Save
    </button>
    <button id="sgs-key-skip"
      style="background:transparent;color:#5a5e5a;border:none;
             font-size:13px;cursor:pointer;padding:7px 10px;">
      Skip
    </button>
  `;

  document.body.appendChild(banner);

  document.getElementById('sgs-key-save').addEventListener('click', () => {
    const val = document.getElementById('sgs-key-input').value.trim();
    if (!val) return;
    setKey(val);
    banner.remove();
    console.info('[main] API key saved');
  });

  document.getElementById('sgs-key-skip').addEventListener('click', () => {
    banner.remove();
  });

  // Also save on Enter key inside the input
  document.getElementById('sgs-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('sgs-key-save').click();
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

    telemetryPoller.connect('localhost:3000');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Bootstrap on DOMContentLoaded
// ══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Install fetch interceptor before anything else fires a request.
  // Skip in DEV_MODE — no auth needed on localhost.
  if (!DEV_MODE) {
    _initFetchInterceptor();
    _showKeyBanner();
  }

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