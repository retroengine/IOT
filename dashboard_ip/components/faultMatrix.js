/**
 * faultMatrix.js — Smart Grid Sentinel Fault & Warning Matrix Component
 * Phase 6 deliverable. DESIGN.md §9, Infographics 2.3 & 2.4.
 *
 * Renders two sub-grids:
 *   Fault Grid    (3×2) — 6 fault conditions  — red theme
 *   Warning Grid  (3+2) — 5 warning flags     — amber theme
 *
 * Each cell: SVG icon · label · status dot.
 * Active fault:   rgba(226,75,74,0.12) tint + --fault-active dot + .pulse-fault
 * Active warning: rgba(239,159,39,0.12) tint + --warn-active dot  + .pulse-warning
 * Inactive:       transparent bg + --fault-inactive dot, no animation.
 *
 * Header shows live count of active faults and warnings.
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   showWarnings {boolean} — render the warnings sub-grid (default true)
 */

// ── Fault definitions (DESIGN.md §9 INFOGRAPHIC 2.3) ─────────────────────
// dataKey: dot-path into telemetryData; deriveFn overrides key lookup.
const FAULT_CELLS = [
  {
    id:        'over_voltage',
    label:     'Over Voltage',
    dataKey:   'faults.over_voltage',
    icon:      _iconArrowWaveUp('var(--fault-inactive)'),
    iconId:    'ov',
  },
  {
    id:        'under_voltage',
    label:     'Under Voltage',
    // Derived: true when active fault is UNDERVOLT, or UV warning + FAULT state
    deriveFn:  d => {
      const active  = _getField(d, 'faults.active') ?? '';
      const uvWarn  = _getField(d, 'faults.warnings.uv') ?? false;
      const state   = d?.state ?? '';
      return active === 'UNDERVOLT' || (uvWarn && state === 'FAULT');
    },
    icon:      _iconArrowWaveDown('var(--fault-inactive)'),
    iconId:    'uv',
  },
  {
    id:        'over_current',
    label:     'Over Current',
    dataKey:   'faults.over_current',
    icon:      _iconLightning('var(--fault-inactive)'),
    iconId:    'oc',
  },
  {
    id:        'over_temp',
    label:     'Over Temp',
    dataKey:   'faults.over_temp',
    icon:      _iconThermometerUp('var(--fault-inactive)'),
    iconId:    'ot',
  },
  {
    id:        'short_circuit',
    label:     'Short Circuit',
    dataKey:   'faults.short_circuit',
    icon:      _iconCrossedWire('var(--fault-inactive)'),
    iconId:    'sc',
  },
  {
    id:        'sensor_fail',
    label:     'Sensor Failure',
    deriveFn:  d => {
      const active = _getField(d, 'faults.active') ?? '';
      return active === 'SENSOR_FAIL';
    },
    icon:      _iconSensorX('var(--fault-inactive)'),
    iconId:    'sf',
  },
];

// ── Warning definitions (DESIGN.md §9 INFOGRAPHIC 2.4) ───────────────────
const WARNING_CELLS = [
  {
    id:      'warn_ov',
    label:   'OV Warning',
    dataKey: 'faults.warnings.ov',
    icon:    _iconArrowWaveUp('var(--warn-active)'),
    iconId:  'wov',
  },
  {
    id:      'warn_uv',
    label:   'UV Warning',
    dataKey: 'faults.warnings.uv',
    icon:    _iconArrowWaveDown('var(--warn-active)'),
    iconId:  'wuv',
  },
  {
    id:      'warn_oc',
    label:   'OC Warning',
    dataKey: 'faults.warnings.oc',
    icon:    _iconLightning('var(--warn-active)'),
    iconId:  'woc',
  },
  {
    id:      'warn_thermal',
    label:   'Thermal',
    dataKey: 'faults.warnings.thermal',
    icon:    _iconThermometerUp('var(--warn-active)'),
    iconId:  'wth',
  },
  {
    id:      'warn_rising',
    label:   'Curr Rising',
    dataKey: 'faults.warnings.curr_rising',
    icon:    _iconTrendUp('var(--warn-active)'),
    iconId:  'wcr',
  },
];

export class FaultMatrix {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container    = containerEl;
    this._showWarnings = options.showWarnings ?? true;

    // Maps cell id → { wrapper, dot } DOM refs for targeted updates
    this._cellEls = new Map();

    // Track prev active counts to avoid redundant header re-renders
    this._prevFaultCount = -1;
    this._prevWarnCount  = -1;

    this._buildDOM();
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // ── Header ─────────────────────────────────────────────────────────────
    this._header = document.createElement('div');
    this._header.style.cssText = [
      'display: flex',
      'align-items: baseline',
      'justify-content: space-between',
      'margin-bottom: 12px',
    ].join(';');

    this._titleEl = document.createElement('span');
    this._titleEl.style.cssText = [
      'font-size: var(--text-micro)',
      'color: var(--text-muted)',
      'text-transform: uppercase',
      'letter-spacing: 0.08em',
    ].join(';');
    this._titleEl.textContent = 'Fault & Warning Matrix';

    this._countEl = document.createElement('span');
    this._countEl.style.cssText = [
      'font-size: var(--text-micro)',
      'font-variant-numeric: tabular-nums',
    ].join(';');
    this._countEl.textContent = '—';

    this._header.appendChild(this._titleEl);
    this._header.appendChild(this._countEl);
    this._container.appendChild(this._header);

    // ── Fault grid label ────────────────────────────────────────────────────
    this._container.appendChild(_sectionLabel('Fault Conditions'));

    // ── 3×2 Fault grid ──────────────────────────────────────────────────────
    const faultGrid = document.createElement('div');
    faultGrid.style.cssText = [
      'display: grid',
      'grid-template-columns: repeat(3, 1fr)',
      'gap: 8px',
      'margin-bottom: 16px',
    ].join(';');

    for (const def of FAULT_CELLS) {
      const cell = this._buildCell(def, false);
      faultGrid.appendChild(cell.wrapper);
    }

    this._container.appendChild(faultGrid);

    // ── Warning grid label ──────────────────────────────────────────────────
    if (this._showWarnings) {
      this._container.appendChild(_sectionLabel('Warning Flags'));

      // 3+2 arrangement: 3 columns, warnings wrap naturally
      const warnGrid = document.createElement('div');
      warnGrid.style.cssText = [
        'display: grid',
        'grid-template-columns: repeat(3, 1fr)',
        'gap: 8px',
      ].join(';');

      for (const def of WARNING_CELLS) {
        const cell = this._buildCell(def, true);
        warnGrid.appendChild(cell.wrapper);
      }

      this._container.appendChild(warnGrid);
    }
  }

  /**
   * Build one fault/warning cell.
   * @param {object}  def        — cell definition from FAULT_CELLS / WARNING_CELLS
   * @param {boolean} isWarning  — true → amber theme, false → red theme
   * @returns {{ wrapper: HTMLElement, dot: HTMLElement }}
   */
  _buildCell(def, isWarning) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = [
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'gap: 6px',
      'padding: 10px 8px',
      'border-radius: var(--radius-sm)',
      'background: transparent',
      'transition: background-color 300ms ease',
      'position: relative',
      'min-width: 0',
    ].join(';');

    // SVG icon wrapper
    const iconEl = document.createElement('div');
    iconEl.style.cssText = [
      'width: 22px',
      'height: 22px',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'flex-shrink: 0',
    ].join(';');
    iconEl.innerHTML = def.icon;

    // Label
    const labelEl = document.createElement('span');
    labelEl.style.cssText = [
      'font-size: 9px',
      'color: var(--text-muted)',
      'text-align: center',
      'letter-spacing: 0.03em',
      'line-height: 1.2',
      'transition: color 300ms ease',
      'white-space: nowrap',
    ].join(';');
    labelEl.textContent = def.label;

    // Status dot
    const dot = document.createElement('span');
    dot.style.cssText = [
      'display: block',
      'width: 6px',
      'height: 6px',
      'border-radius: 50%',
      'background-color: var(--fault-inactive)',
      'flex-shrink: 0',
      'transition: background-color 300ms ease',
    ].join(';');

    wrapper.appendChild(iconEl);
    wrapper.appendChild(labelEl);
    wrapper.appendChild(dot);

    // Store refs for targeted updates
    this._cellEls.set(def.id, { wrapper, dot, iconEl, labelEl, isWarning });

    return { wrapper, dot };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * @param {object} telemetryData
   */
  update(telemetryData) {
    let activeFaults   = 0;
    let activeWarnings = 0;

    // Update fault cells
    for (const def of FAULT_CELLS) {
      const active = def.deriveFn
        ? def.deriveFn(telemetryData)
        : Boolean(_getField(telemetryData, def.dataKey));

      this._applyCellState(def.id, active, false);
      if (active) activeFaults++;
    }

    // Update warning cells
    if (this._showWarnings) {
      for (const def of WARNING_CELLS) {
        const active = Boolean(_getField(telemetryData, def.dataKey));
        this._applyCellState(def.id, active, true);
        if (active) activeWarnings++;
      }
    }

    // Update header count (only when changed)
    if (activeFaults !== this._prevFaultCount || activeWarnings !== this._prevWarnCount) {
      this._prevFaultCount = activeFaults;
      this._prevWarnCount  = activeWarnings;
      this._renderCount(activeFaults, activeWarnings);
    }
  }

  /**
   * No animationLoop subscription — CSS handles all animation.
   */
  destroy() {
    // Nothing to unsubscribe.
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _applyCellState(cellId, active, isWarning) {
    const refs = this._cellEls.get(cellId);
    if (!refs) return;

    const { wrapper, dot, labelEl } = refs;

    if (active) {
      const bgTint    = isWarning ? 'rgba(239,159,39,0.12)' : 'rgba(226,75,74,0.12)';
      const dotColor  = isWarning ? 'var(--warn-active)'    : 'var(--fault-active)';
      const pulseOn   = isWarning ? 'pulse-warning'         : 'pulse-fault';
      const pulseOff  = isWarning ? 'pulse-fault'           : 'pulse-warning';

      wrapper.style.backgroundColor = bgTint;
      dot.style.backgroundColor     = dotColor;
      labelEl.style.color           = 'var(--text-primary)';

      dot.classList.remove(pulseOff);
      dot.classList.add(pulseOn);
    } else {
      wrapper.style.backgroundColor = 'transparent';
      dot.style.backgroundColor     = 'var(--fault-inactive)';
      labelEl.style.color           = 'var(--text-muted)';
      dot.classList.remove('pulse-fault', 'pulse-warning');
    }
  }

  _renderCount(faults, warnings) {
    if (faults === 0 && warnings === 0) {
      this._countEl.textContent  = 'All clear';
      this._countEl.style.color  = 'var(--health-excellent)';
    } else {
      const parts = [];
      if (faults   > 0) parts.push(`${faults} fault${faults > 1 ? 's' : ''}`);
      if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
      this._countEl.textContent = parts.join(' · ');
      this._countEl.style.color = faults > 0 ? 'var(--fault-active)' : 'var(--warn-active)';
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _sectionLabel(text) {
  const el = document.createElement('div');
  el.style.cssText = [
    'font-size: 9px',
    'color: var(--text-faint)',
    'text-transform: uppercase',
    'letter-spacing: 0.1em',
    'margin-bottom: 6px',
  ].join(';');
  el.textContent = text;
  return el;
}

function _getField(obj, path) {
  if (!path || !obj) return null;
  if (!path.includes('.')) return obj[path] ?? null;
  return path.split('.').reduce((acc, k) => acc?.[k], obj) ?? null;
}

// ── SVG icon generators ───────────────────────────────────────────────────────
// All icons are 22×22 viewBox, stroke-based for CSS variable coloring.

function _iconArrowWaveUp(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 14 Q6 10 9 13 Q12 16 15 11" stroke="${color}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M11 5 L15 9 M15 5 L15 9 L11 9" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

function _iconArrowWaveDown(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 9 Q6 13 9 10 Q12 7 15 11" stroke="${color}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <path d="M11 17 L15 13 M15 17 L15 13 L11 13" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

function _iconLightning(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M13 3 L8 12 H12 L9 19 L17 9 H13 Z" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

function _iconThermometerUp(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="9" y="3" width="4" height="11" rx="2" stroke="${color}" stroke-width="1.4" fill="none"/>
    <circle cx="11" cy="16.5" r="2.5" stroke="${color}" stroke-width="1.4" fill="none"/>
    <path d="M15 5 L17 3 M15 7 L18 7 M15 9 L17 11" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;
}

function _iconCrossedWire(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 11 Q7 8 11 11 Q15 14 18 11" stroke="${color}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
    <line x1="8" y1="7" x2="14" y2="15" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="14" y1="7" x2="8" y2="15" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function _iconSensorX(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="6" width="10" height="10" rx="2" stroke="${color}" stroke-width="1.4" fill="none"/>
    <circle cx="9" cy="11" r="2" stroke="${color}" stroke-width="1.2" fill="none"/>
    <line x1="15" y1="8" x2="19" y2="12" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="19" y1="8" x2="15" y2="12" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
}

function _iconTrendUp(color) {
  return `<svg viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 16 L8 10 L12 13 L19 5" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M15 5 H19 V9" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}
