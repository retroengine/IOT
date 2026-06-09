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
import { Page6Phantom }     from './pages/page6-phantom.js';
import { getKey, setKey, getTargetIp, setTargetIp, isConfigured } from './utils/apiAuth.js';

// ── Dev mode detection ────────────────────────────────────────────────────
// Automatically true on localhost / file:// so the dashboard works immediately
// with mock data without any manual toggle. Set FORCE_DEV_MODE = true to
// override in non-standard dev setups.
const FORCE_DEV_MODE = false;  // override if needed

// DEV_MODE is now strictly controlled by FORCE_DEV_MODE instead of 
// auto-detecting localhost so that Live Server extensions don't trigger mock data.
const DEV_MODE = FORCE_DEV_MODE;

if (DEV_MODE) {
  console.info('[main] DEV_MODE active — using mock telemetry (mockData.js)');
}

// ── Pre-fill MQTT defaults ────────────────────────────────────────────────
// If the user has never visited page4, seed localStorage with the known
// HiveMQ credentials so the form is ready to use immediately.
// Password is intentionally NOT seeded — user must enter it every session.
(function _seedMqttDefaults() {
  const LS_BROKER = 'sgs_mqtt_broker';
  const LS_USER   = 'sgs_mqtt_user';
  const LS_TOPIC  = 'sgs_mqtt_topic';
  if (!localStorage.getItem(LS_BROKER)) {
    localStorage.setItem(LS_BROKER, 'wss://e7fc2b846d3f4104914943838d5c7c27.s1.eu.hivemq.cloud:8884/mqtt');
  }
  if (!localStorage.getItem(LS_USER)) {
    localStorage.setItem(LS_USER,   'sgs-device-01');
  }
  if (!localStorage.getItem(LS_TOPIC)) {
    localStorage.setItem(LS_TOPIC,  'sgs/device/+/telemetry');
  }
})();

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
  phantom:     Page6Phantom,
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
    let urlStr = (input instanceof Request) ? input.url : String(input);

    // Only inject on same-origin requests (device IP) — never on external URLs.
    const isRelative = urlStr.startsWith('/');
    const isSameOrigin = isRelative || urlStr.startsWith(window.location.origin);

    const key = getKey();
    const targetIp = getTargetIp();

    if (isSameOrigin) {
      if (key) {
        // Merge headers without mutating the caller's object
        const merged = new Headers(
          init.headers || (input instanceof Request ? input.headers : {})
        );
        merged.set('X-API-Key', key);
        init = { ...init, headers: merged };
      }

      if (isRelative && targetIp) {
        urlStr = `http://${targetIp}${urlStr}`;
        input = urlStr;
      }
    }

    return _origFetch(input, init);
  };

  console.info('[main] fetch interceptor active — X-API-Key and Target IP injected on same-origin requests');
}

// ══════════════════════════════════════════════════════════════════════════
// First-run key banner — dashboard_ip only
// Shows a small fixed banner at the bottom of the screen when no API key
// is stored. Dismissed permanently once a key is entered.
// ══════════════════════════════════════════════════════════════════════════

function _initConnectUI() {
  const btn = document.getElementById('nav-connect-btn');
  const modal = document.getElementById('connect-modal');
  const ipInput = document.getElementById('connect-ip-input');
  const keyInput = document.getElementById('connect-key-input');
  const cancelBtn = document.getElementById('connect-cancel-btn');
  const saveBtn = document.getElementById('connect-save-btn');

  if (!btn || !modal) return;

  // Pre-fill inputs
  ipInput.value = getTargetIp() || '';
  keyInput.value = getKey() || '';

  // Toggle modal
  btn.addEventListener('click', () => {
    const isVisible = modal.style.display === 'block';
    modal.style.display = isVisible ? 'none' : 'block';
  });

  // Cancel
  cancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // Save
  saveBtn.addEventListener('click', () => {
    const keyVal = keyInput.value.trim();
    const ipVal = ipInput.value.trim();
    
    if (keyVal) setKey(keyVal);
    if (ipVal) setTargetIp(ipVal);

    modal.style.display = 'none';
    console.info('[main] Target connection updated');

    // Refresh telemetry connection with new IP if applicable
    if (ipVal && !DEV_MODE) {
      telemetryPoller.disconnect();
      telemetryPoller.connect(ipVal);
    }
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!modal.contains(e.target) && !btn.contains(e.target)) {
      modal.style.display = 'none';
    }
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

    telemetryPoller.connect(getTargetIp() || window.location.host);
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
  }
  
  // Always init the Connect UI
  _initConnectUI();

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