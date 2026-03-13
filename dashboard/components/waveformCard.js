/**
 * waveformCard.js — Smart Grid Sentinel Waveform Card Component
 * Phase 3 deliverable. DESIGN.md §5.1.4, §5.1.5, §17, §18.
 *
 * Canvas-based oscilloscope waveform. Reads from telemetryBuffer for both
 * voltage and current traces. Registered with animationLoop for 60/30 FPS.
 *
 * Rendering: ALL canvas draw calls via canvasEngine.js — zero ctx.* here.
 * Animation: continuous rAF via animationLoop.subscribe().
 *
 * Component interface (DESIGN.md §17):
 *   constructor(containerEl, options)
 *   update(telemetryData)
 *   destroy()
 *
 * Options:
 *   showVoltage   {boolean}  — draw voltage trace (default true)
 *   showCurrent   {boolean}  — draw current trace (default true)
 *   vMin          {number}   — voltage Y-axis min (default 210)
 *   vMax          {number}   — voltage Y-axis max (default 250)
 *   iMin          {number}   — current Y-axis min (default 0)
 *   iMax          {number}   — current Y-axis max (default 25)
 */

import { animationLoop }                              from '../rendering/animationLoop.js';
import { setupCanvas, clearCanvas, drawWaveform }     from '../rendering/canvasEngine.js';
import { getWaveform }                                from '../telemetry/telemetryBuffer.js';

// ── Color vars (DESIGN.md §2 waveform tokens) ────────────────────────────
const COLOR_VOLTAGE = '--wave-voltage';
const COLOR_CURRENT = '--wave-current';
const COLOR_FAULT   = '--wave-fault';

export class WaveformCard {
  /**
   * @param {HTMLElement} containerEl
   * @param {object}      options
   */
  constructor(containerEl, options = {}) {
    this._container = containerEl;
    this._opts = {
      showVoltage: options.showVoltage ?? true,
      showCurrent: options.showCurrent ?? true,
      vMin:        options.vMin        ?? 210,
      vMax:        options.vMax        ?? 250,
      iMin:        options.iMin        ?? 0,
      iMax:        options.iMax        ?? 25,
    };

    // Current FSM state — determines waveform color
    this._isFault = false;

    this._buildDOM();

    // Bind and register the render callback
    this._onFrame = this._onFrame.bind(this);
    animationLoop.subscribe(this._onFrame);

    // Resize observer — re-setup canvas on container resize
    this._resizeObserver = new ResizeObserver(() => this._setupCanvas());
    this._resizeObserver.observe(this._container);
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  _buildDOM() {
    // Outer wrapper fills the container
    this._wrapper = document.createElement('div');
    this._wrapper.style.cssText = [
      'position: relative',
      'width: 100%',
      'height: 100%',
      'min-height: 120px',
    ].join(';');

    // Canvas element — oscilloscope grid via CSS class
    this._canvas = document.createElement('canvas');
    this._canvas.className = 'waveform-grid';
    this._canvas.style.cssText = [
      'display: block',
      'width: 100%',
      'height: 100%',
      'border-radius: var(--radius-sm)',
    ].join(';');

    this._wrapper.appendChild(this._canvas);
    this._container.appendChild(this._wrapper);

    // Perform initial canvas setup after element is in DOM
    // Use rAF to ensure layout has happened before measuring dimensions
    requestAnimationFrame(() => this._setupCanvas());
  }

  _setupCanvas() {
    if (!this._wrapper.offsetWidth) return; // layout not ready yet
    this._ctx = setupCanvas(this._canvas, this._wrapper);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Called by the page on each telemetry tick.
   * Only updates the FSM state flag — actual drawing happens in _onFrame.
   * @param {object} telemetryData
   */
  update(telemetryData) {
    this._isFault = telemetryData?.state === 'FAULT';
  }

  /**
   * Unsubscribe from the animation loop and disconnect resize observer.
   */
  destroy() {
    animationLoop.unsubscribe(this._onFrame);
    this._resizeObserver.disconnect();
  }

  // ── Animation frame callback ───────────────────────────────────────────────

  _onFrame() {
    if (!this._ctx) return;

    clearCanvas(this._ctx);

    // Resolve colors — both traces switch to fault red on FAULT state
    const vColor = this._isFault ? COLOR_FAULT : COLOR_VOLTAGE;
    const iColor = this._isFault ? COLOR_FAULT : COLOR_CURRENT;

    if (this._opts.showVoltage) {
      const vData = getWaveform('v');
      if (vData.length >= 2) {
        drawWaveform(this._ctx, vData, {
          color:     vColor,
          min:       this._opts.vMin,
          max:       this._opts.vMax,
          lineWidth: 1.5,
          filled:    true,
          fillColor: vColor,
        });
      }
    }

    if (this._opts.showCurrent) {
      const iData = getWaveform('i');
      if (iData.length >= 2) {
        drawWaveform(this._ctx, iData, {
          color:     iColor,
          min:       this._opts.iMin,
          max:       this._opts.iMax,
          lineWidth: 1.2,
          opacity:   0.80,
        });
      }
    }
  }
}
