# Smart Grid Sentinel — Master Dashboard Design Specification
# Version: 3.3 | March 2026
# Status: FINAL — Single source of truth for all dashboard development
# Supersedes: DESIGN_REFERENCE.md, DATA_INVENTORY.md, VISUAL_SPEC.md
#
# Changelog v3.3:
#   - Section 6:  Added canonical FPS Limits table (60 FPS desktop / 30 FPS mobile / 0 hidden)
#                 animationLoop.js implementation added; per-component caps removed
#   - Section 7:  Added Data Update Frequency table (10Hz / 1Hz / 0.5Hz per field group)
#                 Added Telemetry Buffer Sizes spec (WAVEFORM_BUFFER_SIZE=120, SPARKLINE_BUFFER_SIZE=60)
#   - Section 14: Mobile FPS cap bullet replaced with cross-reference to Section 6 canonical table
#
# Changelog v3.2:
#   - Section 4:  Added Zone-Based Layout Model — five named zones replace ad-hoc page regions
#   - Section 5:  Added components 5.15–5.18: System Status Bar, GPU Panel, Energy Flow Map, Signal Path
#   - Section 8:  Page 1 layout updated to reflect zone model with System Status Bar
#   - Section 15: Infographic inventory updated (4 new entries, total 33)
#   - Section 17: NEW — Component Architecture & File Structure
#   - Section 18: NEW — Rendering Engine Separation
#   - Section 19: NEW — Visual Effects Layer (effects.css)
#   - Section 16: 3 new implementation rules (28–30)
#
# Changelog v3.1:
#   - Section 6: Added WebSocket transport as primary live-data channel; HTTP polling demoted to fallback
#   - Section 7: Added payload minification strategy and short-key remapping spec
#   - Section 14: Added mobile waveform rules — Page Visibility API pause + 30 FPS cap

---

## TABLE OF CONTENTS

1.  Design Philosophy
2.  Design Tokens (CSS Variables)
3.  Typography System
4.  Layout & Grid System
5.  Component Library
6.  Animation & Interaction System
7.  Telemetry Data Contract (API Schema v1.3)
8.  Page 1 — Status
9.  Page 2 — Faults & Control
10. Page 3 — Diagnostics
11. Page 4 — Cloud / MQTT
12. Page 5 — Analytics
13. Global Navigation
14. Responsive Breakpoints
15. Infographic Inventory
16. Implementation Rules
17. Component Architecture & File Structure
18. Rendering Engine Separation
19. Visual Effects Layer (effects.css)

---

## 1. DESIGN PHILOSOPHY

### Core Aesthetic
Dark industrial minimalism with organic green undertones. The dashboard must feel simultaneously technical, refined, and calm — professional monitoring software that does not shout.

### Mood
Nocturnal · Industrial · Precision engineering · Data confidence

### Guiding Principles
1. **Data is the hero.** UI chrome is suppressed. Numbers and visualizations dominate.
2. **Contrast without harshness.** Dark cards on darker backgrounds, never black on white.
3. **Restraint in accent color.** Green appears only as a functional indicator, never decoration.
4. **Space as structure.** Generous padding replaces borders and dividers.
5. **State is always visible.** The FSM state badge is persistent across every page — the most critical signal is never hidden.
6. **Every field has a visual treatment.** Raw numbers are the fallback, not the default.

### Visual Treatment by Data Type
| Data nature | Visual treatment |
|---|---|
| Live changing values | Animated waveforms or ticking gauges |
| Health scores (0–100) | Hexagon cells with arc fill |
| Boolean states | Glowing dot indicators or circuit icons |
| Ratios / progress | Arc gauges or segmented fill bars |
| History / trends | Sparklines or dot timelines |
| Enumerated states | Color-coded badge system |
| Connectivity | Animated signal visualizers |
| Protection progress | Arc accumulators |

---

## 2. DESIGN TOKENS (CSS VARIABLES)

```css
:root {

  /* ── Backgrounds ── */
  --bg-page:           #d8dbd5;   /* outer page bg — light grey-green, visible behind dashboard */
  --bg-dashboard:      #0d0f0d;   /* main dashboard container */
  --bg-card-dark:      #131613;   /* standard dark card (most cards) */
  --bg-card-dark-2:    #171b17;   /* slightly lighter dark card variant */
  --bg-card-green:     #1a2e1a;   /* green-tinted card — used for Available Energy / health hero */
  --bg-card-light:     #e8ebe5;   /* light contrast card — max 2 per layout */
  --bg-rec-item:       #1c201c;   /* recommendation / event log item background */
  --bg-week-pill:      #252825;   /* pill button background (dark) */
  --bg-bar-inactive:   #252825;   /* inactive bar in sparkline charts */

  /* ── Text ── */
  --text-primary:      #ffffff;   /* large numbers, headings — on dark */
  --text-muted:        #8a8e8a;   /* labels, units, sub-labels — on dark */
  --text-faint:        #5a5e5a;   /* timestamps, footnotes, three-dot menus — on dark */
  --text-on-light:     #0d0f0d;   /* primary text on light cards */
  --text-muted-light:  #4a4e4a;   /* secondary text on light cards */

  /* ── Borders & Dividers ── */
  --border-subtle:     rgba(255, 255, 255, 0.08);
  --border-pill:       rgba(255, 255, 255, 0.18);
  --border-light-pill: rgba(0, 0, 0, 0.15);

  /* ── Progress & Fill ── */
  --progress-track:    #2a2e2a;
  --progress-fill:     #ffffff;
  --bar-active:        #e8ebe5;   /* active sparkline bar */
  --bar-inactive:      #252825;   /* inactive sparkline bar */
  --bar-width:         3px;
  --bar-gap:           2px;

  /* ── Toggle ── */
  --toggle-track-on:   #4a7a4a;
  --toggle-track-off:  #3a3e3a;
  --toggle-thumb:      #ffffff;

  /* ── FSM State Colors ── */
  --state-boot:        #3B8BD4;   /* blue */
  --state-normal:      #1D9E75;   /* green */
  --state-warning:     #EF9F27;   /* amber */
  --state-fault:       #E24B4A;   /* red */
  --state-recovery:    #1D9E75;   /* teal — same hue as normal but animated */
  --state-lockout:     #A32D2D;   /* dark red — solid, no pulse */

  /* ── Health Score Ramp ── */
  --health-excellent:  #1D9E75;   /* 90–100 */
  --health-good:       #0F6E56;   /* 70–89 */
  --health-degraded:   #EF9F27;   /* 50–69 */
  --health-poor:       #D85A30;   /* 30–49 */
  --health-critical:   #E24B4A;   /* 0–29 */

  /* ── Fault / Warning Colors ── */
  --fault-active:      #E24B4A;   /* active fault — red */
  --fault-inactive:    #2a2e2a;   /* inactive — dark grey */
  --warn-active:       #EF9F27;   /* active warning — amber */
  --warn-inactive:     #2a2e2a;

  /* ── Waveform Colors ── */
  --wave-voltage:      #1D9E75;   /* green */
  --wave-current:      #5DCAA5;   /* teal/cyan */
  --wave-fault:        #E24B4A;   /* red — on fault condition */

  /* ── Spacing ── */
  --space-xs:          8px;
  --space-sm:          12px;
  --space-md:          16px;
  --space-lg:          24px;
  --space-xl:          32px;
  --space-2xl:         40px;

  /* ── Border Radius ── */
  --radius-sm:         8px;
  --radius-md:         12px;
  --radius-lg:         16px;
  --radius-xl:         20px;
  --radius-pill:       100px;

  /* ── Typography ── */
  --font-primary:      'DM Sans', 'Syne', 'Space Grotesk', system-ui, sans-serif;
  --font-mono:         'JetBrains Mono', 'Fira Code', 'Courier New', monospace;

  /* ── Type Scale (fluid) ── */
  --text-hero:         clamp(40px, 5vw, 64px);   /* sensor values, large numbers */
  --text-large:        clamp(28px, 3vw, 40px);   /* section headers, page titles */
  --text-section:      clamp(18px, 2vw, 24px);   /* card section headers */
  --text-card-title:   16px;
  --text-label:        13px;
  --text-micro:        11px;

  /* ── Shadows ── */
  --shadow-card:       0 2px 12px rgba(0, 0, 0, 0.4);
  --shadow-dashboard:  0 20px 60px rgba(0, 0, 0, 0.5);

  /* ── Z-Index Stack ── */
  --z-base:            1;
  --z-card:            10;
  --z-nav:             100;
  --z-modal:           1000;
}
```

---

## 3. TYPOGRAPHY SYSTEM

### Font
Primary: **DM Sans** (preferred) · Syne · Space Grotesk · system-ui fallback
Mono: **JetBrains Mono** — used only for raw JSON payload inspector (Page 4)

### Scale & Usage
| Role | Size | Weight | Letter-spacing | Color |
|---|---|---|---|---|
| Hero numbers (sensor values) | 56–64px | 300 | -0.02em | `--text-primary` |
| Range notation (min–max) | 56–64px | 300 | -0.02em | `--text-primary` |
| Page title | 28–32px | 400 | -0.01em | `--text-primary` |
| Section header | 20–24px | 400 | -0.01em | `--text-primary` |
| Card title | 16–18px | 400 | 0 | `--text-primary` |
| Data labels / units | 12–13px | 400 | 0.02em | `--text-muted` |
| Navigation links | 14–15px | 400 | 0 | `--text-primary` |
| Category names | 13–14px | 400 | 0 | `--text-primary` |
| Timestamps / footnotes | 12px | 400 | 0 | `--text-faint` |
| Badge text | 12–13px | 500 | 0.04em | varies by state |

### Typography Rules
- All numbers use `font-variant-numeric: tabular-nums` — never allow variable-width digit rendering
- Range notation always uses **en-dash** (–), never a hyphen (-): `"218–235 V"` not `"218-235 V"`
- Unit labels always appear **below** the number, never inline
- Category / channel names appear **above** their chart or value
- Trend arrows (↑ ↓) appear inline with category name, after a space, in `--text-primary` (neutral white — never red/green alarm coloring)
- Font weight is **light (300)** for all hero numbers — never bold
- On light cards (`--bg-card-light`), all text inverts to `--text-on-light` and `--text-muted-light`

---

## 4. LAYOUT & GRID SYSTEM

### Dashboard Container
```
Outer page background:    var(--bg-page)      #d8dbd5
Dashboard container:      var(--bg-dashboard) #0d0f0d
Max-width:                1280px
Side padding:             32–40px
Border-radius:            16–20px  (dashboard is a rounded card on the grey page)
Shadow:                   var(--shadow-dashboard)
```

### Desktop Grid (1025px+)
```
Navigation:     full width, 56px height
Page header:    full width, ~60px height
Main content:   CSS Grid

Primary layout (Status, Diagnostics):
  3 columns: 50% | 25% | 25%

Bottom row layout:
  Column A: ~18%  (small metric card)
  Column B: ~35%  (medium report card)
  Column C: ~47%  (wide feature card)

Card gap:       12–16px
Card padding:   24–28px
Card radius:    14–16px
Card border:    none — defined by background contrast only
```

### Card Hierarchy
```
Level 1 (page background):  #0d0f0d
Level 2 (standard card):    #131613
Level 3 (card variant):     #171b17
Level 4 (item inside card): #1c201c
Level 5 (contrast card):    #e8ebe5  ← light, max 2 per layout
Level 6 (green accent card):  #1a2e1a  ← used for health hero only
```

### Zone-Based Layout Model

The dashboard is composed of **five named zones** arranged vertically. Each zone has a distinct
visual language and purpose. Think of this as a zone map, not a collection of pages — on large
screens multiple zones are visible simultaneously.

```
┌───────────────────────────────────────────────────────┐
│  ZONE 1 — SYSTEM STATUS BAR                           │
│  50–70px · FSM badge · alerts · connection · clock    │
├───────────────────────────────────────────────────────┤
│  ZONE 2 — LIVE TELEMETRY GAUGES                       │
│  Arc gauges · primary measurements · confidence       │
├────────────────────────────┬──────────────────────────┤
│  ZONE 3A                   │  ZONE 3B                 │
│  ENERGY FLOW MAP           │  GPU STATUS PANELS       │
│  Animated node diagram     │  Compact metric strips   │
├────────────────────────────┴──────────────────────────┤
│  ZONE 4 — WAVEFORM TELEMETRY                          │
│  Oscilloscope-style voltage + current scrolling waves │
├───────────────────────────────────────────────────────┤
│  ZONE 5 — HEX HEALTH GRID                             │
│  Honeycomb health scores · subsystem status           │
└───────────────────────────────────────────────────────┘
```

**Zone characteristics:**

| Zone | Height | Visual language | Density |
|---|---|---|---|
| 1 System Status Bar | 50–70px fixed | Typography + badges + dots | Minimal — one line |
| 2 Live Telemetry | ~200px | Arc gauges + waveforms | Medium |
| 3A Energy Flow | ~280px | SVG node diagram + animations | Sparse — air and motion |
| 3B GPU Panels | ~280px | Compact bars + sparklines | High — maximum data density |
| 4 Waveform | ~160px | Canvas oscilloscope | Immersive — full width |
| 5 Hex Health | ~180px | Hexagon grid | Medium |

**Zone-to-page mapping:**
```
Status page:      All 5 zones visible (the default "home" view)
Faults page:      Zone 1 (updated) + fault-specific content replaces Zones 2–5
Diagnostics page: Zone 1 + Zones 2/3B/5 (no energy flow map)
Cloud page:       Zone 1 + connectivity-specific content
Analytics page:   Zone 1 + historical chart zones
```

**Glowing signal paths connect zones visually.** Each arc gauge in Zone 2 has a thin SVG
signal line running down to its corresponding GPU panel in Zone 3B. These paths are
decorative but reinforce the system-diagram aesthetic. (See Component 5.18 and Section 19.)

---

## 5. COMPONENT LIBRARY

### 5.1 Navigation Bar
```
Layout:       flex, space-between, align-center
Height:       56px
Background:   transparent (inherits dashboard bg)
Padding:      0 var(--space-xl)

Left:
  Logo icon (white geometric, ~32px)
  Nav links: Status | Faults | Diagnostics | Cloud | Analytics
  Link style: 14px, weight 400, --text-primary, gap 24px
  Active link: same weight, brighter — no underline

Right:
  FSM State Badge (always visible — see Section 5.2)
  Account: "Marlene Novak ↓" (optional, on detail views)
```

### 5.2 FSM State Badge (Global Persistent)
```
Shape:        pill, 80×24px
Position:     top-right of navigation on every page
Font:         12–13px, weight 500, letter-spacing 0.04em, uppercase

State → color mapping:
  BOOT:     background var(--state-boot),     text white, no animation
  NORMAL:   background var(--state-normal),   text white, static
  WARNING:  background var(--state-warning),  text dark, slow pulse 1.5s
  FAULT:    background var(--state-fault),    text white, fast pulse 0.8s
  RECOVERY: background var(--state-recovery), text white, rotating arc overlay
  LOCKOUT:  background var(--state-lockout),  text white, solid — no animation
```

### 5.3 Standard Dark Card
```
Background:    var(--bg-card-dark) #131613
Border-radius: 14–16px
Padding:       24px
Shadow:        var(--shadow-card) or none
Header row:    flex, space-between — title left, "···" right
```

### 5.4 Light Contrast Card
```
Background:    var(--bg-card-light) #e8ebe5
Border-radius: 14–16px
Padding:       24px
Text:          var(--text-on-light), var(--text-muted-light)
Usage:         Max 2 per layout — used for Tracking card, Green Energy card
```

### 5.5 Green Accent Card
```
Background:    var(--bg-card-green) #1a2e1a
Border-radius: 14–16px
Padding:       24px
Text:          var(--text-primary) white
Usage:         Health hero only — Available Energy / System Health
```

### 5.6 Three-Dot Menu "···"
```
Symbol:     "···" or Unicode "⋯"
Color:      var(--text-faint)
Position:   top-right of every card header row
Size:       ~20×20px tap target
```

### 5.7 Pill Button
```
Dark pill:
  Background:    var(--bg-week-pill) #252825
  Border:        1px solid var(--border-pill)
  Border-radius: var(--radius-pill)
  Padding:       6px 14px
  Font:          12–13px, weight 400, --text-primary

Outline pill (on dark):
  Background:    transparent
  Border:        1px solid var(--border-pill)

Outline pill (on light):
  Background:    transparent
  Border:        1px solid var(--border-light-pill)
```

### 5.8 Mini Sparkline Bar Chart
```
Container:  full width of column, height 110–130px
Bars:       ~30–40 bars, 3px wide, 2px gap
Active bar: var(--bar-active) #e8ebe5
Inactive:   var(--bar-inactive) #252825
No axes, no labels, no grid lines
Heights:    data-driven, varying to create waveform silhouette
```

### 5.9 Data Range Display
```html
<div class="data-range">
  <span class="range-value">218–235</span>
  <span class="range-unit">V (phase A)</span>
</div>
```
```
range-value:  var(--text-hero), weight 300, --text-primary, tabular-nums
range-unit:   12px, --text-muted, margin-top 4px, display block
```

### 5.10 Progress Bar (thin)
```
Height:    2px
Track:     var(--progress-track) #2a2e2a, border-radius 1px
Fill:      var(--progress-fill) #ffffff, border-radius 1px
```

### 5.11 Toggle Switch
```
Track:     pill, 40×22px
Active:    var(--toggle-track-on) #4a7a4a
Inactive:  var(--toggle-track-off) #3a3e3a
Thumb:     white circle, 18px, subtle shadow
Animate:   slide + color transition 200ms ease
```

### 5.12 State / Fault Badge (inline)
```
Pill with colored background.

NORMAL:   green bg, dark green text
WARNING:  amber bg, dark amber text
FAULT:    red bg, white text
LOCKOUT:  dark red bg, white text
RECOVERY: teal bg, white text
BOOT:     blue bg, white text
SENSOR_FAIL / fault types: red bg, white text
```

### 5.13 Dot Timeline
```
Container:  flex row, position relative
Line:       1px dashed, --text-muted, absolute behind dots

Dots:
  Active:   14×14px, background var(--text-on-light) or white, solid fill
  Inactive: 14×14px, transparent fill, 2px border --text-muted
  
Time labels: below each dot, 11px, --text-muted
```

### 5.14 Weekly Report Table
```
Columns:    7 (Mon–Sun), equal width
Header:     day abbreviation + trend arrow, 12px, --text-muted
Value:      kWh number, 14–15px, --text-primary
Unit row:   "kWh", 11px, --text-muted

Active column:
  Header background: white pill (#ffffff), text inverted --text-on-light
  Border-radius on header: var(--radius-pill)
  Indicator: small white underline beneath column header
```

### 5.15 System Status Bar (Zone 1)
```
Purpose:    Single-glance system awareness — always at the top, never scrolls away
Height:     50–70px fixed
Background: var(--bg-dashboard) #0d0f0d — slightly separated from Zone 2 by a
            1px border: var(--border-subtle) rgba(255,255,255,0.08)
Layout:     flex row, align-center, gap 24px, padding 0 var(--space-xl)

Left group:
  FSM State Badge (see 5.2) — this is its canonical home in the Zone model

Center group (flex, gap 20px):
  Grid mode indicator:  "GRID ONLINE" — 12px uppercase, letter-spacing 0.08em,
                        color var(--health-excellent) when connected, --state-fault when not
  Alert counter:        "⚡ 2 ALERTS" — amber when > 0, --text-muted when 0
  MQTT indicator:       "MQTT ✓" or "MQTT ✗" — dot + label, 12px

Right group:
  Timestamp: live clock "12:31:04" — 14px, --font-mono, --text-muted

State change glow:
  When FSM state changes, the entire status bar gets a brief glow flash:
    NORMAL:   box-shadow 0 0 20px rgba(29, 158, 117, 0.25)  (green glow)
    WARNING:  box-shadow 0 0 20px rgba(239, 159, 39, 0.25)  (amber glow)
    FAULT:    box-shadow 0 0 20px rgba(226, 75, 74, 0.35)   (red glow)
    LOCKOUT:  box-shadow 0 0 20px rgba(163, 45, 45, 0.45)   (dark red glow)
  Duration: 800ms ease-out fade back to zero
  Color values are all derived from existing state tokens — no new colors

File: /components/fsmBadge.js + /pages/statusPage.js
```

### 5.16 GPU-Style Status Panel (Zone 3B)
```
Purpose:    High-density compact metric cards — maximum data per pixel
Inspired by NVIDIA/GPU monitoring dashboards — adapted to the green-dark palette

Per panel card (background: var(--bg-card-dark-2) #171b17):
  Header row:
    Left:  metric name — 12px, var(--text-muted), uppercase, letter-spacing 0.06em
    Right: live value — 16px, var(--text-primary), --font-primary, tabular-nums

  Mini progress bar (below header):
    Height:  6px
    Track:   var(--progress-track) #2a2e2a
    Fill:    width = value / max * 100%
    Color zones (same thresholds as existing gauges):
      Good:     var(--health-excellent) #1D9E75
      Warning:  var(--state-warning)    #EF9F27
      Fault:    var(--state-fault)      #E24B4A

  Sparkline (below bar):
    Height: 28px, full width
    Line:   1px stroke, var(--health-excellent) at opacity 0.6
    No axes, no labels

  Card padding:   12–14px (compact — tighter than standard 24px cards)
  Card radius:    var(--radius-md) 12px
  Card gap:       8px (tighter than standard)

Panels displayed (one card per metric):
  Voltage        → sensors.voltage.filtered_value     (range 0–300V)
  Current        → sensors.current.filtered_value     (range 0–5A)
  Temperature    → sensors.temperature.filtered_value (range 0–100°C)
  Real Power     → power.real_power_w                 (range 0–max)
  WiFi Signal    → network.wifi_rssi                  (range -100 to 0 dBm)
  Fault Prob.    → prediction.fault_probability       (range 0–100%)

Layout: 2-column grid within Zone 3B, 3 rows × 2 columns = 6 panels

File: /components/gpuStatusPanel.js
```

### 5.17 Energy Flow Map (Zone 3A)
```
Purpose:    Make the UI feel like an industrial system diagram, not an IoT toy
Visual:     SVG animated node diagram — energy flowing through the protection system

Nodes (4 nodes connected by animated lines):
  GRID INPUT  ───►  ESP32 PROTECTION  ───►  RELAY  ───►  LOAD

Node visual:
  Shape:      rounded rectangle, 80×36px
  Background: var(--bg-card-dark-2) #171b17
  Border:     1px solid var(--border-subtle)
  Label:      12px uppercase, var(--text-muted)
  Status dot: 8px circle, color = current health state

Node states:
  Healthy:  border color var(--health-excellent) #1D9E75, faint green glow
  Warning:  border color var(--state-warning) #EF9F27, faint amber glow
  Fault:    border color var(--state-fault) #E24B4A, faint red glow — relay node OPEN

Connector lines:
  Type:     SVG <path> elements between nodes
  Stroke:   1.5px, var(--health-excellent) #1D9E75 at opacity 0.4 (healthy)
            shifts to var(--state-fault) #E24B4A when relay is OPEN
  Style:    straight lines with directional arrowheads at endpoints

Animated energy pulses (on healthy flow):
  Small bright dot (~4px) traveling along each connector line
  Color:    var(--health-excellent) #1D9E75 at full opacity
  Speed:    2s per path segment, repeating (CSS animation offset-distance)
  Technique: SVG <circle> with CSS offset-path + offset-distance animation
  Pause:    pulses stop when relay is OPEN (energy flow interrupted)
  Mobile:   pulses disabled below 768px (battery / performance)

Value overlays on lines:
  Small text label riding each connector: "230V · 2.1A · 848W"
  Font: 11px var(--text-muted), updated on each telemetry frame
  Background: var(--bg-card-dark) with 4px padding, var(--radius-sm)

Container:
  Background: var(--bg-card-dark) #131613
  Border-radius: var(--radius-lg)
  Padding: var(--space-lg)
  Height: ~200px within Zone 3A

Data:
  sensors.voltage.filtered_value, sensors.current.filtered_value,
  power.real_power_w, loads.relay1.state, alerts.fsm_state

File: /components/energyFlowMap.js
Used in: /pages/statusPage.js, /pages/analyticsPage.js
```

### 5.18 Signal Path (Glowing Connector Lines)
```
Purpose:    Visual connectors between related components — reinforces system-diagram aesthetic
            Specifically: arcs in Zone 2 connected to their GPU panels in Zone 3B

Type:       SVG absolute-positioned overlay layer (z-index: var(--z-base))

Visual:
  Thin SVG <path> lines connecting a Zone 2 arc gauge to its Zone 3B GPU panel
  Stroke:      0.75px, color = current metric state color at opacity 0.3
  Endpoint dots: 3px circles at both ends, same color at opacity 0.5
  Hover:       opacity increases to 0.7, stroke to 1px

Animated pulse on signal path:
  Same technique as Energy Flow Map (offset-path traveling dot)
  Dot size:  2px
  Speed:     1.5s, continuous, opacity 0.6
  Color:     inherits from parent metric state color
  Pause on hidden tab: Page Visibility API (see Section 14)

No new colors:
  Voltage path:    var(--wave-voltage) #1D9E75
  Current path:    var(--wave-current) #5DCAA5
  Temperature path:var(--state-warning) #EF9F27 if warn, else var(--health-excellent)
  On fault:        var(--state-fault) #E24B4A

Implementation note:
  Paths are drawn on a single full-page SVG overlay. Coordinates are computed at
  runtime from getBoundingClientRect() of source + destination elements.
  Recomputed on window resize.

Files: /components/signalPath.js, /styles/effects.css

---

## 6. ANIMATION & INTERACTION SYSTEM

### Performance Contract
- **Only animate**: `opacity`, `transform` (translate/scale/rotate)
- **Never animate**: `width`, `height`, `top`, `left` — causes layout reflow
- All animations wrapped in `@media (prefers-reduced-motion: no-preference)`
- Waveforms use `requestAnimationFrame` via `animationLoop.js` — never `setInterval`

### FPS Limits (Canonical Reference)

These are the authoritative frame rate targets for all rendered components.
The mobile cap rule in Section 14 is an implementation detail of this table.

```
Context                   Target FPS   Frame interval   Applies to
────────────────────────────────────────────────────────────────────────────
Desktop (≥ 768px)         60 FPS       16.7ms           waveformChart
                                                         energyFlowMap pulses
                                                         signalPath dots
                                                         arcGauge transitions
Mobile  (< 768px)         30 FPS       33.3ms           all of the above
Hidden tab (any size)      0 FPS       ∞ (paused)       all animated components
Reduced-motion (any)       0 FPS       ∞ (paused)       all animated components
```

**Implementation:** The FPS cap is enforced once in `animationLoop.js` using a
timestamp delta guard. Components never implement their own cap — they just subscribe
to the shared loop which already handles the limit.

```javascript
// /rendering/animationLoop.js  — FPS cap added to singleton loop
const IS_MOBILE = window.matchMedia('(max-width: 767px)').matches;
const FRAME_INTERVAL = IS_MOBILE ? 1000 / 30 : 1000 / 60;  // 33.3ms or 16.7ms
let lastTick = 0;

function tick(timestamp) {
  rafHandle = requestAnimationFrame(tick);
  if (document.hidden) return;                        // Page Visibility guard
  if (timestamp - lastTick < FRAME_INTERVAL) return;  // FPS cap guard
  lastTick = timestamp;
  for (const cb of subscribers) cb(timestamp);
}
```

This single guard location means updating the FPS target for all components at once
requires changing one constant in one file.

### Timing Reference
| Event | Duration | Easing |
|---|---|---|
| State color transitions | 600ms | ease-in-out |
| Arc/ring fill on load | 500ms | ease-out |
| Number count-up on load | 400ms | ease-out |
| Card slide-up on load | 300ms + stagger | ease-out |
| Waveform scroll | continuous | linear CSS translateX |
| Toggle switch | 200ms | ease |
| FAULT pulse | 0.8s infinite | ease-in-out |
| WARNING pulse | 1.5s infinite | ease-in-out |
| RECOVERY rotate | 2s infinite | linear |
| Hexagon arc fill | 500ms + stagger 80ms | ease-out |
| Countdown ring | 100ms intervals | linear |

### Page Load Sequence
1. Background and nav fade in (0ms)
2. Cards slide up with stagger: 100ms, 200ms, 300ms per row
3. Numbers count up from 0 to live value (400ms)
4. Sparkline bars animate from bottom (500ms, staggered)
5. Arc gauges fill from 0 to value (500ms)

### Interaction Behaviors
- **Bar chart hover**: individual bar highlights, tooltip shows exact value
- **Dot timeline**: dots clickable, active dot scales 1.0→1.2
- **Weekly table column**: click to set active column, smooth highlight transition
- **FSM State ring**: color transitions 800ms ease-in-out on state change
- **Hexagon hover**: scale 1.05, tooltip shows stability label + key metric
- **"···" menu**: dropdown on click

### Live Data Transport — WebSocket-First

The dashboard uses a **persistent WebSocket connection** as the primary telemetry channel.
HTTP polling (`GET /api/telemetry`) is retained only as a fallback when WebSocket is unavailable.

**Rationale:** HTTP polling forces the ESP32 to spin up and tear down a full TCP connection
every 2 seconds — expensive on the heap and capable of introducing jitter into ADC sampling.
A single persistent WebSocket connection carrying the same ~4KB JSON push every 2 seconds
is dramatically lighter on the firmware network stack.

```
Primary transport:   WebSocket (ws://<device-ip>/ws)
  Connection:        Opened once on page load, kept alive
  Push interval:     ESP32 pushes telemetry every 2s (server-initiated)
  Reconnect policy:  Exponential backoff — 1s, 2s, 4s, 8s, 16s, cap 30s
  On reconnect:      Re-subscribe, re-render with first received frame
  Heartbeat:         Client sends ping frame every 10s; ESP32 responds pong
                     If no pong within 5s — mark connection lost, start reconnect

Fallback transport:  HTTP polling (GET /api/telemetry) — only when WebSocket fails
  Poll interval:     every 2s (same cadence as WS push)
  Activation:        Automatically if WebSocket connection cannot be established
                     after 3 consecutive reconnect attempts
  Deactivation:      Reverts to WebSocket once connection recovers
  Visual indicator:  Show "HTTP fallback" chip in connectivity bar when active

Non-streaming endpoints (always HTTP):
  POST /api/reset        FSM reset command
  GET  /api/log          NVS event log (polled every 10s)
  POST /api/log/clear    Clear event log
```

**Connection state machine (client-side):**
```
CONNECTING → OPEN → (WS push every 2s) → normal operation
     ↓ on failure
RECONNECTING (backoff) → after 3 fails → HTTP_FALLBACK
     ↓ when WS recovers
OPEN (resumes WS, drops HTTP fallback)
```

**Connectivity bar update:** Section 1.11 must display the active transport mode:
- WS connected: green dot + "WebSocket"
- HTTP fallback: amber dot + "HTTP fallback"
- Both down: red dot + "Offline — last seen X seconds ago"

### Live Refresh Cadence
```
Telemetry (WS push):   every 2s  (server-initiated)
Telemetry (HTTP):      every 2s  (fallback polling only)
Waveform update:       on each telemetry frame
Number displays:       on each telemetry frame
MQTT status dot:       derived from each telemetry frame
NVS event log:         every 10s (GET /api/log — always HTTP)
Countdown timer:       every 100ms (computed client-side, no server call)
Clock display:         every 1s (system time, no server call)
```

---

## 7. TELEMETRY DATA CONTRACT

### API Endpoints
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/telemetry` | Full telemetry JSON, schema v1.3, ~4KB |
| POST | `/api/reset` | Request FSM reset |
| GET | `/api/log` | NVS event log (up to 50 entries) |
| POST | `/api/log/clear` | Clear NVS event log |
| GET | `/` | Serve dashboard HTML |

### Data Update Frequency

The telemetry JSON arrives as a single ~4KB blob every 2 seconds. Not every field changes
at the same rate. The frontend store must track per-field effective update rates so that
rendering engines only redraw when their data has actually changed.

```
Field group                         Effective update rate   Consumer
────────────────────────────────────────────────────────────────────
sensors.voltage.filtered_value      10 Hz  (via WS push)   waveformChart, arcGauge
sensors.current.filtered_value      10 Hz  (via WS push)   waveformChart, arcGauge
sensors.temperature.filtered_value   1 Hz  (DS18B20 rate)  arcGauge, gpuStatusPanel
power.real_power_w                  10 Hz  (derived from V×I) gpuStatusPanel, fillBars
power.apparent_power_va             10 Hz                   gpuStatusPanel
power.energy_estimate_wh             1 Hz  (integrator)    sessionEnergyFill
alerts.fsm_state                     1 Hz  (FSM tick)      fsmBadge, fsmRing, statusBar
alerts.active_fault                  1 Hz                  faultFlagsGrid
prediction.fault_probability         1 Hz  (model rate)    faultProbGauge
prediction.risk_level                1 Hz                  riskBadge
network.wifi_rssi                  0.5 Hz  (slow drift)    connectivityBar, gpuPanel
network.mqtt_connected             0.5 Hz                  connectivityBar, mqttDot
alerts.warnings.*                    1 Hz                  warningFlagsGrid
loads.relay1/2.state                 1 Hz                  relayIcon, energyFlowMap
diagnostics.*                      0.5 Hz  (slow health)   hexHealthGrid, sensorBars
```

**How to implement this in `store.js`:**
```javascript
// Each field tracks its last-changed timestamp.
// Components subscribe to specific fields; they only re-render
// when the field's value differs from the previous frame.
store.subscribe('sensors.voltage.filtered_value', (newVal, oldVal) => {
  if (newVal !== oldVal) waveformChart.push(newVal);
});
```

Note: The ESP32 firmware samples voltage/current at the ADC rate (approx. 1 kHz filtered),
but the telemetry frame only captures the latest filtered value at push time (~2s interval).
The 10 Hz annotation above reflects the *display* update rate driven by WebSocket push
bursts — not the firmware ADC sample rate.

### Telemetry Buffer Sizes

Every component that draws historical data must use these exact buffer sizes.
Using inconsistent sizes causes waveforms and sparklines to show different time windows
for the same data source, which is visually incoherent and wastes memory.

```
Buffer name         Size      Time window       Consumer
──────────────────────────────────────────────────────────────────
Waveform buffer     120 samples  ~12s at 10Hz   waveformChart.js
Sparkline buffer     60 samples  ~120s at 0.5Hz  (per-component)
GPU sparkline        60 samples  ~120s           gpuStatusPanel.js
Energy fill history  60 samples  ~120s at 0.5Hz  sessionEnergyFill
```

**Rules:**
- All buffers are **fixed-size circular (ring) buffers** — oldest sample dropped when full
- Buffer size is a named constant, not a magic number:
  ```javascript
  // /telemetry/store.js
  export const WAVEFORM_BUFFER_SIZE  = 120;  // ~12s at 10Hz
  export const SPARKLINE_BUFFER_SIZE =  60;  // ~120s at 0.5Hz
  ```
- Components import the constant — they never hardcode their own buffer size
- On WebSocket reconnect: buffers are **not** cleared — stale data is preferable to
  a blank waveform for the 1–2 second reconnect window

### MQTT Commands (outbound from dashboard)
| Topic | Payload | Action |
|---|---|---|
| `sgs/device/<id>/cmd` | `{"cmd":"reset"}` | FSM reset |
| `sgs/device/<id>/cmd` | `{"cmd":"reboot"}` | Hardware reboot |
| `sgs/device/<id>/cmd` | `{"cmd":"ping"}` | Connectivity check |

### Payload Minification Strategy

**Context:** The full Schema v1.3 JSON payload sits at ~4KB — right against the comfortable limit
for a single buffer on the ESP32. If heap pressure increases (e.g., after adding WebSocket
overhead), the verbose nested key structure is the first optimisation lever.

**Strategy:** If firmware memory becomes constrained, `telemetry_builder.cpp` may emit a
**minified short-key variant** of the payload. The dashboard's data ingestion layer must
transparently remap short keys to the canonical full-path names before any component reads them.
No component outside the ingestion layer should ever reference a short key directly.

**Short-key remapping table (reference — implement in frontend only):**
```javascript
// frontend/telemetry/keymap.js
// Left:  short key emitted by firmware (minified mode)
// Right: canonical path used everywhere in the dashboard

const KEY_MAP = {
  // sensors
  "v_fil":   "sensors.voltage.filtered_value",
  "v_raw":   "sensors.voltage.raw_value",
  "v_conf":  "sensors.voltage.confidence",
  "i_fil":   "sensors.current.filtered_value",
  "i_raw":   "sensors.current.raw_value",
  "i_conf":  "sensors.current.confidence",
  "t_fil":   "sensors.temperature.filtered_value",
  "t_conf":  "sensors.temperature.confidence",
  // power
  "pw_r":    "power.real_power_w",
  "pw_a":    "power.apparent_power_va",
  "pw_e":    "power.energy_estimate_wh",
  // alerts
  "fsm":     "alerts.fsm_state",
  "flt":     "alerts.active_fault",
  "trips":   "alerts.trip_count",
  "ov":      "alerts.over_voltage",
  "oc":      "alerts.over_current",
  "ot":      "alerts.over_temperature",
  "sc":      "alerts.short_circuit_risk",
  "inr":     "alerts.inrush_event",
  // warnings
  "w_ov":    "alerts.warnings.ov",
  "w_uv":    "alerts.warnings.uv",
  "w_oc":    "alerts.warnings.oc",
  "w_th":    "alerts.warnings.thermal",
  "w_cr":    "alerts.warnings.curr_rising",
  // prediction
  "fp":      "prediction.fault_probability",
  "rl":      "prediction.risk_level",
  // loads
  "r1":      "loads.relay1.state",
  "r2":      "loads.relay2.state",
  // network
  "wifi":    "network.wifi_connected",
  "rssi":    "network.wifi_rssi",
  "mqtt":    "network.mqtt_connected",
  "tls":     "network.mqtt_tls_verified",
  "ip":      "network.ip",
  // system
  "up":      "system.uptime_s",
  "heap":    "system.free_heap",
};
```

**Ingestion contract:**
```
1. Receive raw JSON frame (WebSocket push or HTTP response)
2. Detect schema mode: if frame contains "schema_v" key → verbose mode (v1.3 default)
                        if frame contains "sk" key → short-key minified mode
3. If minified: run remapKeys(frame, KEY_MAP) → produces canonical object
4. All downstream components always consume the canonical object only
5. Never expose raw short keys beyond the ingestion boundary
```

**Firmware side note (for `telemetry_builder.cpp` author):**
When switching to minified mode, add `"sk": 1` as the first field in the JSON object
so the dashboard can detect the mode without ambiguity. Do not change the schema_v field —
it still describes the data model version, not the key encoding.

### Telemetry JSON Schema v1.3 — Key Fields by Dashboard Category

**Category A — Primary Measurements**
```
sensors.voltage.filtered_value       float   V        live voltage
sensors.current.filtered_value       float   A        live current
sensors.temperature.filtered_value   float   °C       live temperature
power.real_power_w                   float   W        V × I × 0.85 PF
power.apparent_power_va              float   VA       V × I
power.energy_estimate_wh             float   Wh       integrated since boot
```

**Category B — Protection Status**
```
alerts.fsm_state                     string           BOOT/NORMAL/WARNING/FAULT/RECOVERY/LOCKOUT
alerts.active_fault                  string           NONE/OVERVOLTAGE/OVERCURRENT/THERMAL/UNDERVOLT/SHORT_CIRCUIT/SENSOR_FAIL
alerts.trip_count                    uint8   0–3      >3 forces LOCKOUT
prediction.risk_level                string           LOW/MODERATE/HIGH/CRITICAL
prediction.fault_probability         uint8   0–100%
loads.relay1.state                   bool             true = CLOSED
loads.relay2.state                   bool             true = CLOSED
actuators.alert_led.state            bool
actuators.buzzer.state               bool
alerts.inrush_event                  bool             blanking window active
```

**Category C — Warning & Fault Flags**
```
alerts.over_voltage                  bool
alerts.over_current                  bool
alerts.over_temperature              bool
alerts.short_circuit_risk            bool
alerts.warnings.ov / uv / oc / thermal / curr_rising   bool (5 flags)
```

**Category D — Connectivity**
```
network.wifi_connected               bool
network.wifi_rssi                    int8    dBm
network.mqtt_connected               bool
network.mqtt_tls_verified            bool
network.ip                           string
network.mqtt_connect_attempts        uint32
network.mqtt_connect_successes       uint32
network.mqtt_publish_total           uint32
network.mqtt_publish_failed          uint32
```

**Category E — System Vitals**
```
system.uptime_s                      uint32  s
system.free_heap                     uint32  bytes
system.reset_reason                  uint8
system.cpu_freq_mhz                  uint16
diagnostics.system_health.overall_health_score   uint8   0–100
diagnostics.system_health.health_status          string  HEALTHY/DEGRADED/CRITICAL
diagnostics.system_health.uptime_quality         string  STABLE/WARMING_UP/SETTLING
diagnostics.system_health.heap_healthy           bool
diagnostics.system_health.cpu_load_estimate_pct  float   %
```

**Category F — Sensor Diagnostics**
```
diagnostics.sensor_health.voltage.stability_score      uint8   0–100
diagnostics.sensor_health.voltage.stability_label      string  EXCELLENT/GOOD/DEGRADED/FAULT
diagnostics.sensor_health.voltage.noise_floor_v        float   V
diagnostics.sensor_health.voltage.snr_db               float   dB
diagnostics.sensor_health.voltage.drift_rate_v_per_s   float   V/s
diagnostics.sensor_health.voltage.min_seen_v           float   V
diagnostics.sensor_health.voltage.max_seen_v           float   V
diagnostics.sensor_health.voltage.saturated            bool

diagnostics.sensor_health.current.stability_score      uint8   0–100
diagnostics.sensor_health.current.stability_label      string
diagnostics.sensor_health.current.noise_floor_a        float   A
diagnostics.sensor_health.current.snr_db               float   dB
diagnostics.sensor_health.current.drift_rate_a_per_s   float   A/s
diagnostics.sensor_health.current.min_seen_a           float   A
diagnostics.sensor_health.current.max_seen_a           float   A
diagnostics.sensor_health.current.saturated            bool

diagnostics.sensor_health.temperature.sensor_present          bool
diagnostics.sensor_health.temperature.read_success_rate_pct   uint8   0–100%
diagnostics.sensor_health.temperature.disconnect_count        uint16
diagnostics.sensor_health.temperature.temp_stable             bool
diagnostics.sensor_health.temperature.stability_score         uint8   0–100
```

**Category G — ADC Health**
```
diagnostics.adc_health.calibration_label              string  NONE/EFUSE_VREF/EFUSE_TP
diagnostics.adc_health.linearity_error_pct            float   %
diagnostics.adc_health.actual_sample_rate_hz          float   Hz
diagnostics.adc_health.expected_sample_rate_hz        float   Hz
diagnostics.adc_health.sample_rate_deviation_pct      float   %
diagnostics.adc_health.saturation_events              uint32
diagnostics.adc_health.health_score                   uint8   0–100
sampling.adc_sample_count                             uint32
sampling.adc_calibrated                               bool
```

**Category H — Power Quality**
```
diagnostics.power_quality.nominal_voltage_v           float   V
diagnostics.power_quality.mean_voltage_v              float   V
diagnostics.power_quality.voltage_deviation_pct       float   %
diagnostics.power_quality.sag_depth_v                 float   V
diagnostics.power_quality.swell_height_v              float   V
diagnostics.power_quality.ripple_pct                  float   %
diagnostics.power_quality.flicker_index               float
diagnostics.power_quality.voltage_stability_score     uint8   0–100
diagnostics.power_quality.power_quality_label         string  EXCELLENT/GOOD/FAIR/POOR
```

### FSM State Reference
| State | Relay | LED | Buzzer | Exit condition |
|---|---|---|---|---|
| BOOT | Closed | OFF | OFF | ADC + DS18B20 ready |
| NORMAL | Closed | OFF | OFF | threshold breach |
| WARNING | Closed | ON | OFF | clears or escalates |
| FAULT | OPEN | ON | ON | dead time expires (5s/15s/30s) |
| RECOVERY | Closed | ON | OFF | 500ms stable or re-trip |
| LOCKOUT | OPEN | ON | ON | API reset only |

### Reset Guard Conditions (reset blocked if any true)
1. Temperature ≥ `TEMP_RESET_BLOCK_C`
2. DS18B20 disconnected (`sensor_present == false`)
3. `FAULT_BIT_SENSOR` still active

---

## 8. PAGE 1 — STATUS

**Purpose:** Instant real-time operational overview. Answers "Is the system OK?" in under 2 seconds.
This page renders all five zones (see Section 4 Zone-Based Layout Model).

### Zone Layout (Page 1 — Status)
```
┌─────────────────────────────────────────────────────────────────────┐
│ NAV: [●] SGS  Status  Faults  Diagnostics  Cloud  Analytics         │
├─────────────────────────────────────────────────────────────────────┤
│ ZONE 1 — SYSTEM STATUS BAR                                          │
│ [NORMAL]  GRID ONLINE  ⚡ 0 ALERTS  MQTT ✓  TLS ✓       12:31:04   │
├─────────────────────────────────────────────────────────────────────┤
│ ZONE 2 — LIVE TELEMETRY GAUGES (+ hero section)                     │
│                                                                     │
│   [Fault Prob Arc]    [FSM STATE RING]    [Risk Level Badge]        │
│                                                                     │
│  Voltage Card    │  Current Card    │  Temperature Card             │
│  [wave + spark]  │  [wave + spark]  │  [arc gauge]                  │
│  230.4 V         │  2.18 A          │  48.3 °C                      │
├──────────────────┴──────────────────┴───────────────────────────────┤
│ ZONE 3A — ENERGY FLOW MAP         │ ZONE 3B — GPU STATUS PANELS     │
│                                   │                                 │
│  GRID ──► ESP32 ──► RELAY ──► LOAD│  Voltage     231V  ██████░░░░  │
│  ···►···►···►···►···►···►···►···  │  Current    2.1A  █████░░░░░  │
│  230V · 2.1A · 848W               │  Temperature 48°C  ████████░░  │
│                                   │  Real Power  848W  ██████░░░░  │
│  [relay circuit icon]             │  WiFi RSSI  -52dB  ███████░░░  │
│  Real Power  848 W                │  Fault Prob   12%  ██░░░░░░░░  │
├───────────────────────────────────┴─────────────────────────────────┤
│ ZONE 4 — WAVEFORM TELEMETRY                                         │
│ Voltage:  ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿  230.4V      │
│ Current:  ≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈    2.18A      │
├─────────────────────────────────────────────────────────────────────┤
│ ZONE 5 — HEX HEALTH GRID                                            │
│  ⬡Voltage  ⬡Current  ⬡Temp  ⬡ADC  ⬡System                         │
│  87        84        95     91    88                                 │
│                            Relay Status  Actuators  Connectivity    │
└─────────────────────────────────────────────────────────────────────┘
```

**Signal paths (SVG overlay):** Component 5.18 draws thin glowing lines from each Zone 2
arc gauge downward to its corresponding GPU panel in Zone 3B. These lines are rendered on a
transparent SVG overlay layer and do not affect card layout.

---

### INFOGRAPHIC 1.1 — FSM STATE RING
```
Type:    Animated SVG ring (~180×180px)
Purpose: Primary system state indicator — is everything OK?

Visual:
  Outer thick ring (stroke ~12px) encodes current state color
  Thin grey track ring behind it (100% background)
  Inner label: state name (var(--text-hero) size, weight 300)
  Sub-label below: "Active for 2m 14s" (var(--text-muted))

State → color:
  BOOT:     var(--state-boot)     #3B8BD4  animate: slow pulse
  NORMAL:   var(--state-normal)   #1D9E75  animate: static solid
  WARNING:  var(--state-warning)  #EF9F27  animate: slow pulse 1.5s
  FAULT:    var(--state-fault)    #E24B4A  animate: fast pulse 0.8s
  RECOVERY: var(--state-recovery) #1D9E75  animate: rotating arc
  LOCKOUT:  var(--state-lockout)  #A32D2D  animate: none (locked)

On state change: ring color transitions 800ms ease-in-out
Pulse: @keyframes scale 1.0 → 1.04 → 1.0, opacity 0.8 → 1.0 → 0.8

Data: alerts.fsm_state, alerts.timestamp (for duration)
```

---

### INFOGRAPHIC 1.2 — FAULT PROBABILITY GAUGE
```
Type:    Semi-circular arc gauge (140×80px)
Purpose: Predictive fault probability, 0–100%

Visual:
  Half-circle arc, 180° sweep, bottom-open
  Track: var(--progress-track) #2a2e2a, 8px stroke
  Fill arc — color zone by value:
    0–20:   var(--health-excellent) #1D9E75
    21–45:  var(--state-warning)    #EF9F27
    46–75:  var(--health-poor)      #D85A30
    76–100: var(--state-fault)      #E24B4A
  Thin white needle from center point to arc position
  Center number: "45%" var(--text-large) weight 300
  Sub-label: "fault probability" var(--text-muted) 12px

Animation: arc length updates smoothly on data poll (300ms ease)

Data: prediction.fault_probability (0–100)
```

---

### INFOGRAPHIC 1.3 — RISK LEVEL BADGE
```
Type:    Color-coded pill badge with icon (120×36px)
Purpose: Risk classification at a glance

Visual:
  Pill shape, left: small shield icon, right: text uppercase
  LOW:      green bg (#1D9E75), dark text
  MODERATE: amber bg (#EF9F27), dark text
  HIGH:     orange bg (#D85A30), white text
  CRITICAL: red bg   (#E24B4A), white text

Data: prediction.risk_level
```

---

### INFOGRAPHIC 1.4 — VOLTAGE WAVEFORM CARD
```
Type:    Animated SVG/Canvas oscilloscope waveform
Purpose: Live voltage — motion communicates "system is live"

Visual:
  Card: var(--bg-card-dark), standard dark card
  Waveform: scrolling sine wave, var(--wave-voltage) #1D9E75
  Scrolls leftward continuously via CSS translateX
  Amplitude encodes deviation from nominal (230V):
    V = nominal:         normal amplitude
    V > 253V (OV warn):  amplitude ↑ + color shifts amber
    V < 207V (UV warn):  amplitude ↓ + color shifts blue
    V in FAULT:          color shifts var(--wave-fault) #E24B4A
  Rolling 10-second window
  Faint horizontal reference lines at min_seen / max_seen
  No axis labels (minimalist)

  Below waveform:
    Large value: "230.4 V" — var(--text-hero) weight 300
    Unit row: "voltage" — var(--text-muted) 12px
    Confidence chip: "conf: 94%" — small, var(--text-muted)

  Sparkline history (mini bar chart, 80px tall, below waveform):
    ~30 bars, var(--bar-active) for recent, var(--bar-inactive) older

Card dimensions: ~280×200px
Data: sensors.voltage.filtered_value, sensors.voltage.confidence,
      diagnostics.sensor_health.voltage.min_seen_v/max_seen_v
```

---

### INFOGRAPHIC 1.5 — CURRENT WAVEFORM CARD
```
Type:    Animated SVG/Canvas oscilloscope waveform
Purpose: Live current — phase-offset from voltage wave for visual differentiation

Visual: Identical layout to voltage card with these differences:
  Waveform color: var(--wave-current) #5DCAA5 (teal/cyan)
  Wave appears phase-shifted (~30° offset) from voltage display
  Amplitude: scales with current magnitude (0–5A range)
  Large value: "2.18 A"
  On FAULT: same color shift to var(--wave-fault)

Data: sensors.current.filtered_value, sensors.current.confidence
```

---

### INFOGRAPHIC 1.6 — TEMPERATURE ARC GAUGE
```
Type:    270° arc gauge (speedometer style, 140×140px)
Purpose: Temperature with clear threshold zone coloring

Visual:
  270° arc, open at bottom-left
  Arc color zones:
    0–40°C:    blue-teal (safe/cool)
    40–60°C:   var(--health-excellent) green (normal operating)
    60–75°C:   var(--state-warning) amber (TEMP_WARN zone)
    75–85°C:   var(--health-poor) orange
    85°C+:     var(--state-fault) red (TEMP_FAULT zone)
  Thin white needle from center to current position
  Center large value: "48.3°C" var(--text-large) weight 300
  Sub-label: "temperature" var(--text-muted)
  DS18B20 indicator dot (bottom):
    Green ● = sensor present
    Red ● = sensor disconnected

Data: sensors.temperature.filtered_value,
      diagnostics.sensor_health.temperature.sensor_present
```

---

### INFOGRAPHIC 1.7 — POWER VERTICAL FILL BARS
```
Type:    Segmented vertical fill bars (2 cards side by side)
Purpose: Real and apparent power relative to system capacity

Visual per bar:
  Tall thin bar: 24px wide × 80px tall
  5 segments, each lights at 20% intervals
  Fill color by load percentage:
    0–40%:   var(--health-excellent) green
    40–70%:  var(--state-warning) amber
    70–100%: var(--state-fault) red
  Large value below bar: "847.2 W"
  Sub-label: "real power" or "apparent power", var(--text-muted)

Data: power.real_power_w, power.apparent_power_va
Note: system_max_power = configurable constant (use nominal * 1.2 as estimate)
```

---

### INFOGRAPHIC 1.8 — SESSION ENERGY FILL
```
Type:    Horizontal fill bar with faint area chart background
Purpose: Cumulative energy since last boot — only resets on reboot

Visual:
  Wide horizontal fill bar (full card width)
  Fills left-to-right as energy accumulates
  Faint area chart drawn behind bar (shows accumulation rate history)
  Warm green-amber gradient fill
  Right-side value: "1.24 Wh" var(--text-section)
  Sub-label: "session energy (since boot)" var(--text-muted)
  Note badge: "resets on reboot" var(--text-faint) 11px

Data: power.energy_estimate_wh
```

---

### INFOGRAPHIC 1.9 — RELAY CIRCUIT ICONS
```
Type:    SVG circuit breaker schematic icons (2 per relay)
Purpose: Instant OPEN/CLOSED state — engineering-literate iconography

Visual per relay:
  CLOSED: connected arc symbol, green dot, "CLOSED" label
  OPEN:   broken arc symbol, red dot, "OPEN" label
  Animation on transition: smooth 300ms break/connect arc motion
  Relay label: "Relay 1" / "Relay 2" above icon
  Card shows both relays side by side

Data: loads.relay1.state, loads.relay2.state
```

---

### INFOGRAPHIC 1.10 — ACTUATOR STATUS
```
Type:    Icon + label indicators
Purpose: LED and buzzer hardware state

Visual:
  LED indicator:
    ON:  bright white dot ●, "LED ON" label
    OFF: dim grey dot ○, "LED OFF"
  Buzzer indicator:
    ON:  amber speaker icon, "BUZZER ON"
    OFF: grey muted speaker, "BUZZER OFF"
  Inrush blanking:
    Active: amber badge "INRUSH BLANK ACTIVE"
    Inactive: hidden

Data: actuators.alert_led.state, actuators.buzzer.state, alerts.inrush_event
```

---

### INFOGRAPHIC 1.11 — CONNECTIVITY BAR
```
Type:    Compact fixed status bar
Purpose: Always-visible connectivity health

Visual (flex row, full width):
  WiFi:
    4 animated signal bars, fill by RSSI:
      > -50 dBm: 4 bars, green
      -50 to -65: 3 bars, green
      -65 to -75: 2 bars, amber
      < -75: 1 bar, red
      Disconnected: all grey
    RSSI value: "-52 dBm" var(--text-muted)
  MQTT:
    Pulsing dot (green=connected, grey=disconnected)
    "MQTT" label + "●" or "○"
  TLS:
    Lock icon ✓ green if verified, amber if unverified
    "TLS" label
  IP:
    "192.168.x.x" var(--text-faint) 12px
  Uptime:
    "↑ 2h 34m" var(--text-muted)

Data: network.wifi_rssi, network.mqtt_connected, network.mqtt_tls_verified,
      network.ip, system.uptime_s
```

---

## 9. PAGE 2 — FAULTS & CONTROL

**Purpose:** Fault investigation, state machine inspection, event history, and system reset. The only page with control actions.

### Grid Layout
```
┌─────────────────────────────────────────────────────────────────────┐
│ NAV                                                     [FSM badge] │
├──────────────────────────────────────┬──────────────────────────────┤
│  FSM STATE FLOW DIAGRAM              │  TRIP COUNTER STEPS          │
│  [mini state machine, current lit]   │  ①——②——③  "Trip 2 of 3"     │
├──────────────────────────────────────┴──────────────────────────────┤
│  FAULT FLAGS GRID (6)              │  WARNING FLAGS GRID (5)         │
│  [icon + label + status dot ×6]    │  [icon + label + dot ×5]        │
├────────────────────────────────────┴─────────────────────────────── ┤
│  IDMT ACCUMULATOR ARC              │  RECLOSE COUNTDOWN TIMER        │
│  0.000 ──────────────── 1.000      │  [circular countdown ring]      │
├────────────────────────────────────┴─────────────────────────────── ┤
│  RESET GUARD PANEL                                                   │
│  [✓/✗ Temperature] [✓/✗ DS18B20] [✓/✗ No sensor fault]             │
│  [RESET BUTTON]  [REBOOT]  [PING]                                   │
├─────────────────────────────────────────────────────────────────────┤
│  NVS EVENT LOG TIMELINE                             [CLEAR LOG]     │
│  ● 2h 14m ago  [FAULT] [OVERCURRENT]  "FAULT_OVERCURRENT entered"  │
│  ● 2h 16m ago  [NORMAL]               "Recovered after reclose"    │
└─────────────────────────────────────────────────────────────────────┘
```

---

### INFOGRAPHIC 2.1 — FSM STATE FLOW DIAGRAM
```
Type:    SVG state machine diagram (~400×160px)
Purpose: Show all states, current one highlighted, valid transitions visible

Visual:
  6 nodes in flow layout:
    BOOT → NORMAL ⇄ WARNING → FAULT → RECOVERY → NORMAL
                                     ↘ LOCKOUT

  Node rendering:
    Current state: bright fill (state color), larger (scale 1.15), white text
    Other states:  muted background, small text var(--text-faint)

  Node colors (active / muted pairs):
    BOOT:     #3B8BD4 / #1a2a3a
    NORMAL:   #1D9E75 / #0f3025
    WARNING:  #EF9F27 / #3a2a10
    FAULT:    #E24B4A / #3a1515
    RECOVERY: #1D9E75 / #0f3025
    LOCKOUT:  #A32D2D / #2a1010

  Arrows:
    Valid transitions: white, 1px
    Lockout-bypass path: red, 2px, labeled "direct lockout"
    Re-entry from RECOVERY: dashed

  Transition animation: node glow and arrow highlight on state change (600ms)

Data: alerts.fsm_state
```

---

### INFOGRAPHIC 2.2 — TRIP COUNTER STEPS
```
Type:    Step indicator (3 steps connected by line)
Purpose: Show proximity to LOCKOUT

Visual:
  Three circles: ①——②——③
  Filled = completed trip:
    Trip 1: amber fill #EF9F27
    Trip 2: orange fill #D85A30
    Trip 3: red fill #E24B4A
  Unfilled = remaining: grey circle outline
  At trip 3: red arrow label "→ LOCKOUT" appears right of step 3
  Text below: "Trip 2 of 3 — 1 remaining before lockout"

Data: alerts.trip_count (0–3)
```

---

### INFOGRAPHIC 2.3 — FAULT FLAGS GRID
```
Type:    Icon grid, 3×2 cells
Purpose: All active fault conditions at a glance

Per cell (inactive state):
  Dark background: var(--fault-inactive) #2a2e2a
  Small SVG icon (topical), label below, grey dot

Per cell (active state):
  Background: subtle red tint (rgba(226, 75, 74, 0.12))
  Red dot indicator
  Label color: var(--text-primary)

Faults and icons:
  1. Over Voltage    — upward arrow in wave
  2. Under Voltage   — downward arrow in wave
  3. Over Current    — lightning bolt
  4. Over Temp       — thermometer with upward arrow
  5. Short Circuit   — crossed wire symbol
  6. Sensor Failure  — sensor with X mark

Data:
  alerts.over_voltage, alerts.over_current, alerts.over_temperature,
  alerts.short_circuit_risk, alerts.active_fault (for UV, Sensor)
```

---

### INFOGRAPHIC 2.4 — WARNING FLAGS GRID
```
Type:    Icon grid, 5 cells (1×5 or arranged 3+2)
Purpose: All active warnings — amber theme

Same structure as Fault Flags but:
  Active cell: subtle amber tint (rgba(239, 159, 39, 0.12))
  Amber dot

Warnings and icons:
  1. OV Warning      — upward arrow (amber)
  2. UV Warning      — downward arrow (amber)
  3. OC Warning      — lightning bolt (amber)
  4. Thermal Warning — thermometer (amber)
  5. Current Rising  — rising trend line (amber)

Data: alerts.warnings.ov/uv/oc/thermal/curr_rising
```

---

### INFOGRAPHIC 2.5 — IDMT ACCUMULATOR ARC
```
Type:    Horizontal progress arc bar, IEC 60255 protection visualization
Purpose: Show thermal memory accumulation toward overcurrent trip

Visual:
  Full-width bar (0.000 left → 1.000 right)
  Fill color zones:
    0.00–0.50: var(--health-excellent) green
    0.50–0.80: var(--state-warning) amber
    0.80–1.00: var(--state-fault) red
  Small arrowhead on fill front edge
  At 1.000: "TRIPPED" label appears at right
  Tick marks at 0.25, 0.50, 0.75, 1.00
  Title: "IDMT accumulator — IEC 60255 Standard Inverse"
  Sub-label: "Thermal memory — decays slowly below pickup"

Note: Direct accumulator value not in telemetry v1.3.
Display logic:
  alerts.warnings.oc == true:  fill at estimated 0.5–0.9 (interpolate with confidence)
  alerts.over_current == true: fill at 1.0 (tripped)
  neither:                     fill at 0.0–0.4

Data: alerts.warnings.oc, alerts.over_current
```

---

### INFOGRAPHIC 2.6 — RECLOSE COUNTDOWN TIMER
```
Type:    Circular countdown ring (~100px diameter)
Purpose: Show time until automatic reclose attempt

Visual:
  Ring fills clockwise as countdown depletes
  Center text: "8.4s" updating every 100ms
  Sub-label: "Auto-reclose in..."
  Dead time info: "Trip 2 → 15s dead time"
  At 0s: ring completes, "Reclosing..." text
  If all guards blocked: dim ring, "Blocked" overlay
  Hidden when FSM state is not FAULT

Dead times: Trip 1 = 5s, Trip 2 = 15s, Trip 3 = 30s
Countdown computed client-side from trip detection time.

Display condition: alerts.fsm_state == "FAULT"
Data: alerts.trip_count, alerts.fsm_state
```

---

### INFOGRAPHIC 2.7 — RESET GUARD CHECKLIST
```
Type:    Vertical checklist with live status (3 rows)
Purpose: Precisely show why reset is or isn't available

Each row:
  [✓ green OR ✗ red]  [Guard name]  [Live value]  [Status message]

Row 1 — Temperature:
  ✓: "Temperature OK — 48°C (limit: 85°C)"
  ✗: "Temperature BLOCKED — 91°C exceeds 85°C limit"
  Value: sensors.temperature.filtered_value

Row 2 — DS18B20 sensor:
  ✓: "Sensor present and reading"
  ✗: "DS18B20 DISCONNECTED — reconnect before reset"
  Value: diagnostics.sensor_health.temperature.sensor_present

Row 3 — ADC sensor fault:
  ✓: "No sensor fault active"
  ✗: "SENSOR_FAIL active — inspect ADC wiring before reset"
  Value: alerts.active_fault == "SENSOR_FAIL"

RESET button:
  All 3 guards pass: large green button, enabled
  Any guard fails: grey button, disabled, tooltip shows which guard
  Action: POST /api/reset

REBOOT button: amber, always enabled, Action: MQTT {"cmd":"reboot"}
PING button:   teal,  always enabled, Action: MQTT {"cmd":"ping"}
```

---

### INFOGRAPHIC 2.8 — NVS EVENT LOG TIMELINE
```
Type:    Vertical timeline, newest first
Purpose: Historical record of FSM transitions and fault events

Structure:
  Vertical line on left
  Each entry:
    Dot on line: color = FSM state color of that entry
    Timestamp: "2h 14m ago" (relative) — "Mar 13 09:23" (absolute on hover)
    State badge: colored pill (NORMAL/WARNING/FAULT/etc.)
    Fault badge: if active_fault != NONE, show fault type pill
    Label: event description text (from NVS label field)

Max entries: 50
"Clear Log" button: bottom of list, POST /api/log/clear
Loading state: skeleton rows while fetching

Data: GET /api/log
```

---

## 10. PAGE 3 — DIAGNOSTICS

**Purpose:** Deep sensor and system health analysis. For commissioning, signal quality investigation, and debugging degraded behavior. No control actions — view only.

### Grid Layout
```
┌─────────────────────────────────────────────────────────────────────┐
│ NAV                                                     [FSM badge] │
├─────────────────────────────────────────────────────────────────────┤
│              HEALTH HONEYCOMB (5 hexagons)                          │
│   [Voltage]  [Current]  [Temperature]                               │
│        [ADC]        [System]                                        │
├─────────────────────────────────┬───────────────────────────────────┤
│  POWER QUALITY RADAR CHART      │  SENSOR DETAIL PANELS             │
│  [pentagon spider chart]        │  Voltage:  noise / SNR / drift    │
│  5 axes + power quality badge   │  Current:  noise / SNR / drift    │
│                                 │  Temp:     success rate / stable  │
├─────────────────────────────────┴───────────────────────────────────┤
│  ADC HEALTH PANEL                                                   │
│  [Calibration badge] [Sample rate gauge] [Linearity bar] [Events]  │
├─────────────────────────────────────────────────────────────────────┤
│  SYSTEM HEALTH METRICS                                              │
│  [Heap bar]  [CPU gauge]  [Uptime ring]  [Confidence bars ×3]      │
└─────────────────────────────────────────────────────────────────────┘
```

---

### INFOGRAPHIC 3.1 — HEALTH HONEYCOMB
```
Type:    Hexagon grid (5 cells in honeycomb offset arrangement)
Purpose: THE signature diagnostic visual — all health scores at a single glance

Honeycomb layout:
  Row 1 (3 hexagons): Voltage · Current · Temperature
  Row 2 (2 hexagons, offset): ADC · System

Per hexagon (120×104px each):
  Outer perimeter arc: health score fill (0–100%)
    Color by score: excellent(green) / good(teal) / degraded(amber) /
                    poor(orange) / critical(red)
  Dark fill interior: var(--bg-card-dark) or --bg-card-green
  Center: large score number ("87") var(--text-hero) weight 300
  Below number: channel name ("Voltage") var(--text-label)
  Outer label (below hex): stability label ("EXCELLENT") var(--text-muted)

Load animation:
  Hexagons fade + slide in with 80ms stagger
  Arc animates from 0 to score value in 500ms ease-out
  Number counts up from 0

Hover: scale 1.05, tooltip with stability label + key metric

Data by hexagon:
  1. Voltage     → diagnostics.sensor_health.voltage.stability_score
  2. Current     → diagnostics.sensor_health.current.stability_score
  3. Temperature → diagnostics.sensor_health.temperature.stability_score
  4. ADC         → diagnostics.adc_health.health_score
  5. System      → diagnostics.system_health.overall_health_score
```

---

### INFOGRAPHIC 3.2 — POWER QUALITY RADAR CHART
```
Type:    Chart.js radar (spider/pentagon) chart (~280×280px)
Purpose: Multi-dimensional power quality in a single view

5 axes (all scored 0–100, higher = better quality):
  1. Voltage Stability:   100 - (|voltage_deviation_pct| × 10), clamped 0-100
  2. Sag Resistance:      100 - (sag_depth_v / nominal_voltage_v × 200), clamped 0-100
  3. Swell Resistance:    100 - (swell_height_v / nominal_voltage_v × 200), clamped 0-100
  4. Ripple Quality:      100 - (ripple_pct × 2), clamped 0-100
  5. Flicker Quality:     100 - (flicker_index × 1000), clamped 0-100

Visual:
  Filled area: semi-transparent green rgba(29,158,117,0.25)
  Grid rings: 20/40/60/80/100 at 20% intervals, dark grey
  Vertex labels: axis names
  Score values shown at each vertex
  Power quality badge below: "GOOD" / "EXCELLENT" / "FAIR" / "POOR"
    color coded same as health score ramp

Data: diagnostics.power_quality.*
```

---

### INFOGRAPHIC 3.3 — SENSOR DETAIL PANELS
```
Type:    Horizontal metric bars, grouped by channel
Purpose: Noise, SNR, drift — scannable one-line-per-metric format

Per metric row:
  Label (left, 120px)  [========░░] bar (200px)  value (right, 60px)
  Threshold marker: faint vertical line on bar at "ideal" value
  Color: green (ideal) → amber (marginal) → red (degraded)
  Saturated flag: red ⚠ badge if saturated == true

Voltage channel:
  Noise Floor:   bar 0–5V,  ideal < 1.0V
  SNR:           bar 0–60dB, ideal > 30dB
  Drift Rate:    bar 0–1V/s, ideal ≈ 0
  Min/Max range: ← arrow → span showing min_seen_v ↔ max_seen_v
  Stability badge: "EXCELLENT" / "GOOD" / "DEGRADED" / "FAULT"

Current channel (same layout):
  Noise Floor:   bar 0–1A
  SNR:           bar 0–60dB
  Drift Rate:    bar 0–0.5A/s

Temperature channel:
  Read success rate: horizontal bar 0–100%
  Disconnect count:  counter display, red if > 0
  Temperature stable: boolean badge (STABLE / UNSTABLE)

Data: diagnostics.sensor_health.voltage.*, current.*, temperature.*
```

---

### INFOGRAPHIC 3.4 — ADC HEALTH PANEL
```
Type:    Mixed — badge + gauge + bar + counter
Purpose: ADC hardware calibration and performance status

Calibration Badge (large pill):
  NONE:       Red "#NOT CALIBRATED — accuracy severely limited"
  EFUSE_VREF: Amber "CALIBRATED (VREF)"
  EFUSE_TP:   Green "CALIBRATED (2-POINT)" ← best calibration

Sample Rate Gauge (semi-arc):
  Actual Hz needle vs Expected Hz inner label
  Deviation % as sub-label
  Green < 5% deviation, amber 5–15%, red > 15%

Linearity Error Bar (horizontal):
  Fill 0–5%
  Green < 1%, amber 1–3%, red > 3%

Saturation Events Counter:
  "0 saturation events" — green
  "> 0 events" — red with count
  "voltage_saturated" / "current_saturated" flags as separate indicators

ADC Health Score: circular badge, score number, color from health ramp
Total Samples: "2,847,391 samples" var(--text-muted) 12px

Data: diagnostics.adc_health.*, sampling.*
```

---

### INFOGRAPHIC 3.5 — SYSTEM HEALTH METRICS
```
Type:    Mixed bars, gauge, ring, and scored bars
Purpose: Firmware runtime health

Heap Usage Bar (horizontal):
  Used / Free split
  Color: green if heap_healthy, red if below threshold
  Label: "124,832 bytes free (38% used)"

CPU Load Gauge (small semi-arc):
  0–100%
  Green < 50%, amber 50–80%, red > 80%
  Label: "12.4% estimated"
  Sub-note: "(derived from sample rate deviation)"

Uptime Ring (circular):
  WARMING_UP (< 5 min): small partial fill, blue
  SETTLING   (< 1 hr):  half fill, amber
  STABLE     (> 1 hr):  full ring, green
  Center: uptime formatted "2h 34m" or "14d 3h"
  Sub-label: uptime_quality label

Confidence Score Bars (3 rows):
  Voltage confidence:    [========░] 94%
  Current confidence:    [=======░░] 87%
  Temperature confidence:[=========] 95%
  Green ≥ 80%, amber 60–79%, red < 60%

Data: diagnostics.system_health.*, sensors.*.confidence
```

---

## 11. PAGE 4 — CLOUD / MQTT

**Purpose:** HiveMQ cloud connection health, message flow statistics, MQTT command console, and raw telemetry inspection.

### Grid Layout
```
┌─────────────────────────────────────────────────────────────────────┐
│ NAV                                                     [FSM badge] │
├─────────────────────────────────────────────────────────────────────┤
│  CONNECTION STATUS PANEL                                            │
│  [WiFi bars] [MQTT pulsing dot] [TLS lock] "Connected · TLS OK"    │
│  HiveMQ Cloud · <broker host> · Port 8883 · QoS 1 (cmds) / 0 (tel)│
├────────────────────────────────┬────────────────────────────────────┤
│  SESSION STATISTICS            │  PUBLISH RELIABILITY DONUT         │
│  Connect attempts:   14        │  [donut chart: success/failed]     │
│  Connect successes:  14        │  Center: "99.2% success"           │
│  Success rate:       100%      │  "2847 total / 0 failed"           │
│  Pub total:          2,847     │                                    │
│  Pub failed:         0         │                                    │
│  Last connect:       2h ago    │                                    │
├────────────────────────────────┴────────────────────────────────────┤
│  MQTT TOPIC REFERENCE TABLE                                         │
│  [static topic reference table]                                     │
├─────────────────────────────────────────────────────────────────────┤
│  COMMAND CONSOLE                                                    │
│  [RESET] [REBOOT] [PING]  →  Response area                         │
├─────────────────────────────────────────────────────────────────────┤
│  TELEMETRY PAYLOAD INSPECTOR                                        │
│  [pretty-printed JSON, monospace font]  [Payload size bar]         │
└─────────────────────────────────────────────────────────────────────┘
```

---

### INFOGRAPHIC 4.1 — ANIMATED WIFI SIGNAL BARS
```
Type:    Animated SVG 4-bar signal strength icon
Purpose: RSSI visualization — instantly readable

Visual:
  4 bars of increasing height (standard WiFi convention)
  Lit bars based on RSSI:
    > -50 dBm: 4 bars, var(--health-excellent) green
    -50 to -65: 3 bars, green
    -65 to -75: 2 bars, var(--state-warning) amber
    < -75: 1 bar, var(--state-fault) red
    Disconnected: all bars grey
  Bars pulse once on RSSI value change
  RSSI number below: "-52 dBm" var(--text-muted)

Data: network.wifi_rssi, network.wifi_connected
```

---

### INFOGRAPHIC 4.2 — MQTT STATUS DOT
```
Type:    Pulsing animated dot with label
Purpose: Live MQTT connection indicator

Visual:
  Large dot ~16px
  Connected: var(--health-excellent) green, gentle pulse 2s infinite
  Disconnected: grey, no animation
  TLS verified: small lock icon overlaid bottom-right
  Text: "Connected" or "Disconnected"
  Sub-text: "connected 2h ago" (from system.uptime_s) var(--text-faint)

Data: network.mqtt_connected, network.mqtt_tls_verified
```

---

### INFOGRAPHIC 4.3 — PUBLISH RELIABILITY DONUT
```
Type:    Chart.js doughnut chart
Purpose: Publish success/failure ratio

Visual:
  Donut, 2 segments:
    Successful: var(--health-excellent) green
    Failed: var(--state-fault) red (only visible if > 0)
  Center text: "99.2%" — var(--text-section) weight 300
  Below center: "success rate"
  Sub-label: "2847 total / 0 failed" var(--text-muted)
  100% success: solid green, center text "Perfect"
  Any failures: proportional red segment + failure count

Data: network.mqtt_publish_total, network.mqtt_publish_failed
```

---

### INFOGRAPHIC 4.4 — PAYLOAD SIZE BAR
```
Type:    Horizontal fill bar with limit marker
Purpose: Verify telemetry payload stays within MQTT message size safety zone

Visual:
  Bar: current payload bytes vs 4096 byte buffer limit
  Color: green < 80%, amber 80–90%, red > 90%
  Label: "3,241 / 4,096 bytes (79%)"
  Vertical marker at 80%: dashed line labeled "safe zone"
  Schema badge: "Schema v1.3"
  Device ID: "sgs-AABBCC" var(--text-muted)

Data: derived from response size of GET /api/telemetry,
      telemetry.schema_v, telemetry.device
```

### 4.5 — MQTT TOPIC REFERENCE TABLE
```
Static display table (not data-driven):

| Topic | Direction | Trigger | Payload summary |
|---|---|---|---|
| sgs/device/<id>/telemetry | ↑ Published | Every interval | Full telemetry JSON v1.3 |
| sgs/device/<id>/fault | ↑ Published | FSM → FAULT or LOCKOUT | {ts, event, fault, trips, v, i, t} |
| sgs/device/<id>/state | ↑ Published | Any FSM state change | {ts, event, fault, trips, v, i, t} |
| sgs/device/<id>/cmd | ↓ Subscribed | From dashboard / server | {"cmd":"reset"/"reboot"/"ping"} |
```

### 4.6 — COMMAND CONSOLE
```
3 action buttons:
  RESET:  large green, POST /api/reset + MQTT {"cmd":"reset"}
  REBOOT: amber, MQTT {"cmd":"reboot"} only
  PING:   teal, MQTT {"cmd":"ping"} — response appears in response area

Response area:
  Shows command sent + timestamp + response received
  e.g. "[09:23:14] → ping   [09:23:14] ← pong (2ms)"
  Font: --font-mono 12px
  Background: var(--bg-card-dark-2)
```

### 4.7 — TELEMETRY PAYLOAD INSPECTOR
```
Pretty-printed JSON of last telemetry response
Font: --font-mono 12px
Syntax highlighting: minimal — keys in --text-muted, values in --text-primary
Background: var(--bg-card-dark-2)
Scrollable, max height 400px
Refresh button: re-fetches GET /api/telemetry
```

---

## 12. PAGE 5 — ANALYTICS

**Purpose:** Historical trend analysis. Requires a backend server with a time-series database to function. The dashboard should display graceful "not available" states when no history backend is connected.

**Note:** This page is a Phase 5 deliverable. Phase 3/4 should stub it with a "coming soon" placeholder linked to future backend integration.

### Grid Layout
```
┌─────────────────────────────────────────────────────────────────────┐
│ NAV                                                     [FSM badge] │
├─────────────────────────────────────────────────────────────────────┤
│  TIME RANGE SELECTOR:  [1H] [6H] [24H] [7D] [30D]  [custom range] │
├─────────────────────────────────────────────────────────────────────┤
│  24-HOUR LOAD CURVE                                                 │
│  [area chart: voltage + current overlaid, dual Y-axis]             │
├─────────────────────────────────────────────────────────────────────┤
│  ENERGY CONSUMPTION TREND                                           │
│  [bar chart: daily kWh estimate, 7 or 30 days]                      │
├─────────────────────────────────────────────────────────────────────┤
│  FAULT FREQUENCY ANALYSIS                │  VOLTAGE DISTRIBUTION    │
│  [bar chart: fault types × count]        │  [histogram: V buckets] │
└─────────────────────────────────────────┴─────────────────────────┘
```

### Charts
```
Load Curve:
  Chart.js area chart, dual Y-axis
  Line 1: Voltage (left Y, 180–260V range, green)
  Line 2: Current (right Y, 0–5A range, teal)
  X-axis: time of day (00:00 → 23:59)
  Shaded area below each line

Energy Trend:
  Chart.js bar chart
  X-axis: day labels (Mon–Sun or dates)
  Y-axis: Wh or kWh
  Bar color: green → amber gradient as energy increases

Fault Frequency:
  Chart.js bar chart, horizontal
  Y-axis: fault type names
  X-axis: occurrence count
  Bar color: fault type color from flags grid

Voltage Distribution Histogram:
  Chart.js bar chart
  X-axis: voltage buckets (200–210, 210–220, ..., 250–260V)
  Y-axis: sample count
  Color: bucket within nominal range = green, outside = amber/red
  Reference line at nominal (230V)

Note: All analytics data requires historical storage backend.
      Phase 5 implementation. Until then: "No historical data.
      Connect a time-series backend to enable Analytics."
```

---

## 13. GLOBAL NAVIGATION

```
Height:         56px
Background:     transparent (inherits --bg-dashboard)
Padding:        0 var(--space-xl)
Position:       sticky top-0, z-index var(--z-nav)
Backdrop-filter: blur(8px) on scroll (subtle)

Left section:
  Logo: white geometric SVG icon ~32px
  Links: Status · Faults · Diagnostics · Cloud · Analytics
  Link spacing: gap 24px, 14px, weight 400
  Active state: slightly brighter white (opacity 1.0 vs 0.7)

Right section:
  FSM State Badge (see 5.2)
  Account: "Marlene Novak ↓" (optional)

Separator:
  None — contrast with card backgrounds provides implicit separation

Page header (below nav):
  Flex row, space-between
  Left: page title (28–32px, weight 400)
  Right: live clock "11:37 AM" + sub-label "Time" + date "9 September"
  Live clock updates every 1s
```

---

## 14. RESPONSIVE BREAKPOINTS

| Breakpoint | Range | Layout behavior |
|---|---|---|
| Mobile | 320–480px | Single column, stacked cards. Nav: Logo + "Menu" pill button. Card padding 16–20px. |
| Tablet | 481–768px | Two-column grid. Some cards span full width. |
| Tablet Large | 769–1024px | Approaching desktop. 2–3 column hybrid. |
| Desktop | 1025–1280px | Full 3-column grid. All components visible. |
| Wide Desktop | 1281px+ | Max-width container (1280px) centered on page. |

### Mobile-Specific Rules
- Navigation collapses to: Logo left + "Menu" pill button right
- All cards become single-column full-width
- Waveforms simplify (reduce to sparkline + value)
- Toggle switches maintain full 40×22px size (accessibility)
- Three-dot menus remain on all cards
- Hero FSM ring scales down to ~120px
- **Waveform FPS cap:** On screens narrower than 768px, all rendering is capped to
  **30 FPS**. The cap is enforced centrally in `animationLoop.js` — see Section 6
  "FPS Limits" for the canonical table and implementation. Do not implement per-component
  caps; the shared loop handles it.
- **Page Visibility API — mandatory:** All waveform `requestAnimationFrame` loops
  **must pause completely** when the browser tab is hidden, and resume when it becomes
  visible again. Battery drain and frame-queue buildup on hidden tabs is not acceptable.
  ```javascript
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(waveformRAFHandle);
      waveformRAFHandle = null;
    } else {
      waveformRAFHandle = requestAnimationFrame(animateWaveform);
    }
  });
  ```
  This rule applies to **all animated components** — waveforms, pulsing dots, countdown
  rings, and rotating arcs — on all screen sizes, not only mobile.

---

## 15. INFOGRAPHIC INVENTORY

Complete list of all infographic components across all pages.

| # | Name | Type | Page / Zone | Data source |
|---|---|---|---|---|
| 1.1 | FSM State Ring | Animated SVG arc ring | Status / Z2 | alerts.fsm_state |
| 1.2 | Fault Probability Gauge | Semi-arc gauge | Status / Z2 | prediction.fault_probability |
| 1.3 | Risk Level Badge | Color pill badge | Status / Z2 | prediction.risk_level |
| 1.4 | Voltage Waveform | Scrolling sine wave + sparkline | Status / Z4 | sensors.voltage |
| 1.5 | Current Waveform | Scrolling sine wave + sparkline | Status / Z4 | sensors.current |
| 1.6 | Temperature Arc Gauge | 270° speedometer gauge | Status / Z2 | sensors.temperature |
| 1.7 | Power Fill Bars | Segmented vertical bars ×2 | Status / Z2 | power.real_power_w / va |
| 1.8 | Session Energy Fill | Horizontal fill + area bg | Status / Z2 | power.energy_estimate_wh |
| 1.9 | Relay Circuit Icons | SVG circuit schematics | Status / Z5 | loads.relay1/2.state |
| 1.10 | Actuator Status | Dot + icon indicators | Status / Z5 | actuators.*, inrush_event |
| 1.11 | Connectivity Bar | Signal bars + pulsing dots | Status / Z5 | network.* |
| 1.12 | System Status Bar | Fixed top bar — badges + clock | All / Z1 | fsm_state, alerts, network |
| 1.13 | GPU Status Panels | Compact bar + sparkline grid | Status / Z3B | all primary metrics |
| 1.14 | Energy Flow Map | SVG animated node diagram | Status / Z3A | voltage, current, relay |
| 1.15 | Signal Paths | SVG glowing connector lines | Status / overlay | per-metric state colors |
| 2.1 | FSM Flow Diagram | SVG state machine | Faults | alerts.fsm_state |
| 2.2 | Trip Counter Steps | Step indicator ①②③ | Faults | alerts.trip_count |
| 2.3 | Fault Flags Grid | Icon grid 3×2 | Faults | alerts.over_* |
| 2.4 | Warning Flags Grid | Icon grid 1×5 | Faults | alerts.warnings.* |
| 2.5 | IDMT Accumulator Arc | Protection progress bar | Faults | oc flags (inferred) |
| 2.6 | Reclose Countdown | Circular countdown ring | Faults | fsm_state + trip_count |
| 2.7 | Reset Guard Panel | Live checklist | Faults | temp + sensor + fault |
| 2.8 | Event Log Timeline | Vertical timeline | Faults | GET /api/log |
| 3.1 | Health Honeycomb | Hexagon grid ×5 | Diagnostics / Z5 | all health scores |
| 3.2 | Power Quality Radar | Pentagon spider chart | Diagnostics | power_quality.* |
| 3.3 | Sensor Detail Bars | Horizontal metric bars | Diagnostics | sensor_health.* |
| 3.4 | ADC Health Panel | Badge + gauge + bars | Diagnostics | adc_health.* |
| 3.5 | System Health Metrics | Bars + gauge + ring | Diagnostics | system_health.* |
| 4.1 | WiFi Signal Bars | Animated SVG bars | Cloud | network.wifi_rssi |
| 4.2 | MQTT Status Dot | Pulsing dot | Cloud | network.mqtt_connected |
| 4.3 | Publish Reliability Donut | Chart.js donut | Cloud | mqtt_publish stats |
| 4.4 | Payload Size Bar | Horizontal fill bar | Cloud | response size |
| G.1 | Nav FSM State Badge | Color pill (global) | All / nav | alerts.fsm_state |

**Total: 33 infographic components**

---

## 16. IMPLEMENTATION RULES

### Absolute Rules (never violate)
1. Never use pure black — all darks have a green tint (`#0d0f0d`, `#131613`)
2. Never use colored accents (no blue, red, orange in the UI chrome) — only for functional data states
3. White is the primary accent — used for active states, hero numbers, indicators
4. Cards have no CSS borders — defined by background color contrast only
5. Numbers always use `font-variant-numeric: tabular-nums`
6. En-dash (–) for ranges, never hyphen (-)
7. Units always appear below the number, never inline
8. Trend arrows (↑ ↓) are neutral white — never red/green alarm coloring in the UI chrome
9. Never hardcode sensor values — always consume live API data
10. Font weight for hero numbers is 300 (light) — never bold
11. Three-dot menu on every card header
12. Light cards (`--bg-card-light`) maximum 2 per layout
13. Spacing is generous — prefer breathing room over density

### Data Contract Rules
14. Never break the `/api/telemetry` response contract
15. Dashboard must gracefully handle any missing field (null checks on all JSON paths)
16. Telemetry arrives via WebSocket push (primary) or HTTP poll fallback — cadence is 2s either way
17. Display last known value when connection is lost — do not zero-out on network error
18. Show a "last updated X seconds ago" indicator if data is stale (> 6s since last frame)
19. Short-key remapping (if firmware emits minified payload) must be handled exclusively in the
    ingestion layer — no component outside that layer may reference a short key
20. WebSocket reconnect must use exponential backoff (1s → 2s → 4s → 8s → 16s → 30s cap) —
    never hammer the ESP32 with rapid reconnect attempts

### Firmware Critical Files (must not be modified)
19. `fault_engine.cpp` — fault logic
20. `fsm.cpp` — state machine
21. `telemetry_builder.cpp` — JSON schema

### Analytics Page (Phase 5 dependency)
22. Analytics page requires backend server + time-series database (not in ESP32 firmware)
23. Until Phase 5: render a graceful placeholder — do not leave empty page
24. Session energy (`power.energy_estimate_wh`) resets on reboot — label it clearly

### Accessibility
25. All color-only status indicators must include a text label
26. Toggle switches must maintain 40×22px minimum (touch target)
27. All animations must respect `prefers-reduced-motion`

### Zone & Component Architecture Rules
28. Every new visual component must be placed in a named zone (Z1–Z5) — never floating outside
    the zone model without an explicit reason documented here
29. Glow and pulse effects must reference existing CSS tokens only — no new hex values may be
    introduced for visual effects; all glow colors are derived from `--state-*` and `--health-*`
30. Signal paths (Component 5.18) and energy flow pulses (Component 5.17) must both respect the
    Page Visibility API pause rule from Section 14 — these are animated SVG elements, not waveforms,
    but the battery drain concern applies equally

---

## 17. COMPONENT ARCHITECTURE & FILE STRUCTURE

### Directory Layout
```
/dashboard
  index.html                   ← entry point, served by ESP32 at GET /
  /components                  ← one file per UI component
    fsmBadge.js                ← FSM State Badge (Zones 1 + Nav)
    arcGauge.js                ← Arc gauge (Zone 2 — voltage/current/temperature)
    waveformChart.js           ← Oscilloscope waveform (Zone 4)
    energyFlowMap.js           ← SVG energy node diagram (Zone 3A)
    gpuStatusPanel.js          ← Compact metric strips (Zone 3B)
    signalPath.js              ← SVG glowing connector lines (overlay)
    hexHealthGrid.js           ← Honeycomb health scores (Zone 5)
    relayIcon.js               ← Circuit breaker SVG icon
    connectivityBar.js         ← WiFi + MQTT + TLS status bar
    eventLogTimeline.js        ← NVS log vertical timeline
    resetGuardPanel.js         ← Reset guard checklist + buttons
    fsmFlowDiagram.js          ← State machine SVG diagram
    tripCounter.js             ← Step indicator ①②③
    idmtArc.js                 ← IDMT accumulator progress bar
    recloseCd.js               ← Reclose countdown ring
    powerQualityRadar.js       ← Spider/radar chart (Chart.js)
    publishDonut.js            ← MQTT reliability donut (Chart.js)
    payloadBar.js              ← Payload size indicator
  /rendering                   ← shared rendering engines (see Section 18)
    canvasEngine.js
    svgEngine.js
    animationLoop.js
  /telemetry                   ← data ingestion layer
    wsClient.js                ← WebSocket client + HTTP fallback
    keymap.js                  ← short-key remapping (Section 7)
    store.js                   ← reactive data store (last known values)
  /styles
    tokens.css                 ← all CSS variables (Section 2 tokens)
    layout.css                 ← zone grid layout
    effects.css                ← glow, pulse, signal animations (Section 19)
    components.css             ← per-component structural styles
  /pages
    statusPage.js              ← assembles all 5 zones for Status view
    faultsPage.js
    diagnosticsPage.js
    cloudPage.js
    analyticsPage.js
```

### Component Pattern (mandatory structure for every component)
```javascript
// Example: arcGauge.js
// Rule: Never import from /pages or /telemetry directly.
// Components receive data as plain JS objects — they do not fetch.

export class ArcGauge {
  constructor(containerEl, options = {}) { /* ... */ }

  // Called by page with canonical telemetry object
  update(data) { /* read data fields, update visuals */ }

  // Cleanup — called when page unmounts
  destroy() { /* cancel rAF, remove listeners */ }
}
```

**Separation rules:**
- **Logic** (telemetry parsing, state inference) lives in `/telemetry`
- **Rendering** (canvas draws, SVG updates) lives in `/rendering`
- **Components** coordinate between the two — they do not contain raw draw calls
- **Pages** assemble components — they do not contain business logic
- Never mix telemetry fetching and DOM rendering in the same function

---

## 18. RENDERING ENGINE SEPARATION

Components must not contain raw Canvas or SVG draw calls. All low-level rendering
goes through shared engines. This prevents duplicated animation loops and ensures
the Page Visibility API pause applies universally.

### /rendering/animationLoop.js
```javascript
// Singleton animation loop — all animated components register here.
// One requestAnimationFrame loop for the entire dashboard.
// Respects Page Visibility API for all registered callbacks.

const subscribers = new Set();

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(rafHandle);
  else rafHandle = requestAnimationFrame(tick);
});

function tick(timestamp) {
  for (const cb of subscribers) cb(timestamp);
  rafHandle = requestAnimationFrame(tick);
}

export const animationLoop = {
  subscribe(callback)   { subscribers.add(callback); },
  unsubscribe(callback) { subscribers.delete(callback); },
};
```

### /rendering/canvasEngine.js
```javascript
// Provides: drawWaveform(ctx, data, options)
//           drawSparkline(ctx, data, options)
//           clearCanvas(ctx)
// Handles DPR (devicePixelRatio) scaling once.
// Components call these helpers — they never call ctx.* directly.
```

### /rendering/svgEngine.js
```javascript
// Provides: createArcPath(cx, cy, r, startAngle, endAngle)
//           createSignalPath(fromEl, toEl)
//           animateOffsetPath(el, duration)
//           updateArcLength(el, score)
// All SVG geometry math lives here.
// Components call these helpers.
```

### Why this matters
One `requestAnimationFrame` loop instead of one per component means:
- The Page Visibility pause in animationLoop.js covers every animation automatically
- The mobile 30 FPS cap (Section 14) is enforced in one place
- No duplicate `cancelAnimationFrame` calls across 10+ components

---

## 19. VISUAL EFFECTS LAYER (effects.css)

All glow, pulse, signal, and data-stream effects are centralised in `effects.css`.
Components apply class names — they never write `box-shadow` or `animation` inline.

**Critical constraint:** Every color value in this file must reference an existing
CSS variable. No new hex values. The green-dark palette is locked (see Section 2).

```css
/* ================================================================
   effects.css — Smart Grid Sentinel visual effects
   All values reference existing tokens from tokens.css
   ================================================================ */

/* ── Glow utilities ── */
.glow-normal   { box-shadow: 0 0 12px rgba(29,  158, 117, 0.30); }
.glow-warning  { box-shadow: 0 0 12px rgba(239, 159,  39, 0.30); }
.glow-fault    { box-shadow: 0 0 16px rgba(226,  75,  74, 0.40); }
.glow-lockout  { box-shadow: 0 0 16px rgba(163,  45,  45, 0.50); }
.glow-recovery { box-shadow: 0 0 12px rgba(29,  158, 117, 0.25); }

/* Dynamic glow — applied via JS dataset.state */
[data-state="NORMAL"]   { box-shadow: 0 0 12px rgba(29,  158, 117, 0.30); }
[data-state="WARNING"]  { box-shadow: 0 0 12px rgba(239, 159,  39, 0.30); }
[data-state="FAULT"]    { box-shadow: 0 0 18px rgba(226,  75,  74, 0.45); }
[data-state="LOCKOUT"]  { box-shadow: 0 0 18px rgba(163,  45,  45, 0.55); }
[data-state="RECOVERY"] { box-shadow: 0 0 12px rgba(29,  158, 117, 0.20); }
[data-state="BOOT"]     { box-shadow: 0 0 10px rgba(59,  139, 212, 0.25); }

/* ── Status bar flash — fires once on FSM state change ── */
@keyframes statusBarFlash {
  0%   { box-shadow: 0 0 0px transparent; }
  30%  { box-shadow: 0 0 24px var(--flash-color, rgba(29,158,117,0.4)); }
  100% { box-shadow: 0 0 0px transparent; }
}
.status-bar-flash {
  animation: statusBarFlash 800ms ease-out forwards;
}
/* JS sets --flash-color on .status-bar element before adding class */

/* ── Pulse animations (WARNING / FAULT badges) ── */
@keyframes pulseSlow {
  0%, 100% { opacity: 0.80; transform: scale(1.00); }
  50%       { opacity: 1.00; transform: scale(1.04); }
}
@keyframes pulseFast {
  0%, 100% { opacity: 0.75; transform: scale(1.00); }
  50%       { opacity: 1.00; transform: scale(1.05); }
}
.pulse-warning { animation: pulseSlow 1.5s ease-in-out infinite; }
.pulse-fault   { animation: pulseFast 0.8s ease-in-out infinite; }

/* ── Rotating arc (RECOVERY state ring) ── */
@keyframes rotateArc {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
.rotate-recovery { animation: rotateArc 2s linear infinite; }

/* ── Signal path pulse dot (energy flow + signal lines) ── */
/* Dot travels along SVG path via offset-distance */
@keyframes travelPath {
  from { offset-distance: 0%; }
  to   { offset-distance: 100%; }
}
.signal-dot {
  offset-path: path('M0,0');   /* overridden per-instance by svgEngine.js */
  offset-rotate: 0deg;
  animation: travelPath 2s linear infinite;
  /* color set via fill property, referencing state tokens */
}
.signal-dot--voltage     { fill: var(--wave-voltage);  opacity: 0.85; }
.signal-dot--current     { fill: var(--wave-current);  opacity: 0.85; }
.signal-dot--temperature { fill: var(--state-warning); opacity: 0.75; }
.signal-dot--fault       { fill: var(--state-fault);   opacity: 0.90; }

/* ── Energy flow connector line ── */
.flow-line {
  stroke-width: 1.5px;
  stroke: var(--health-excellent);
  opacity: 0.35;
  transition: stroke 600ms ease-in-out, opacity 300ms ease;
}
.flow-line--fault {
  stroke: var(--state-fault);
  opacity: 0.50;
}
.flow-line--interrupted {
  stroke-dasharray: 4 4;
  opacity: 0.25;
  animation: none; /* no pulses when relay is open */
}

/* ── Signal path (Zone 2 → Zone 3B connectors) ── */
.signal-path-line {
  stroke-width: 0.75px;
  opacity: 0.30;
  transition: opacity 300ms ease, stroke-width 200ms ease;
}
.signal-path-line:hover,
.signal-path-line.active {
  opacity: 0.70;
  stroke-width: 1px;
}

/* ── Waveform oscilloscope grid ── */
.waveform-grid {
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 40px 20px;
}

/* ── Respect reduced motion ── */
@media (prefers-reduced-motion: reduce) {
  .pulse-warning, .pulse-fault, .rotate-recovery,
  .signal-dot, .status-bar-flash {
    animation: none;
  }
  .flow-line, .signal-path-line {
    transition: none;
  }
}
```

---

*End of DESIGN.md*
*Version: 3.3 | March 2026*
*Supersedes all previous design documents.*
*This file is the single source of truth for Smart Grid Sentinel dashboard development.*
