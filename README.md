# Smart Grid Sentinel — Demo Build

ESP32 dual-core power protection system with self-healing FSM, dual relay load shedding, 
inrush-aware fault detection, NVS event logging, MQTT telemetry, HTTP REST API, and a 
standalone web dashboard that can be hosted anywhere.

---

## Hardware (Demo Pinout)

| Pin    | Device        | Notes                          |
|--------|---------------|--------------------------------|
| GPIO34 | Voltage POT   | ADC1_CH6, input-only           |
| GPIO35 | Current POT   | ADC1_CH7, input-only           |
| GPIO4  | DS18B20       | 4.7 kΩ pull-up to 3.3 V req'd |
| GPIO21 | OLED SDA      | I²C, 0x3C                      |
| GPIO22 | OLED SCL      | I²C, 400 kHz                   |
| GPIO26 | Load1 Relay   | Active-LOW, main load          |
| GPIO27 | Load2 Relay   | Active-LOW, aux load           |
| GPIO14 | Alert LED     | Active-HIGH                    |
| GPIO25 | Passive Buzzer| LEDC channel 0, PWM            |

---

## Fault Protection

| Fault        | Threshold          | Warning        |
|--------------|--------------------|----------------|
| Overvoltage  | > 253 V            | > 245 V        |
| Undervoltage | < 207 V            | < 215 V        |
| Overcurrent  | > 1.5 A            | > 1.0 A        |
| Thermal      | > 75 °C            | > 65 °C        |
| Curr Rising  | slope prediction   | pre-fault only |

**High-load safety features:**
- **Inrush blanking** — OC suppressed 600 ms after relay close (motors/compressors)
- **Asymmetric IIR** — fast rise (α=0.5), slow fall (α=0.1) on current
- **Median pre-filter** — 3-sample median removes EMI/commutation spikes
- **Adaptive debounce** — heavier loads require more consecutive samples to trip
- **Task watchdog** — 10 s WDT on both FreeRTOS tasks, panic on expiry
- **Brownout detector** — clean reset if supply voltage sags below 2.43 V

---

## Repository Structure

```
sgs/
├── src/
│   ├── main.cpp            # FreeRTOS task setup, WDT, brownout
│   ├── config.h            # ALL compile-time constants
│   ├── types.h             # Shared structs + enums
│   ├── adc_sampler.cpp/h   # ADC oversampling + IIR + rolling avg
│   ├── ds18b20.cpp/h       # Non-blocking 1-Wire temp
│   ├── fault_engine.cpp/h  # 5-fault IEC debounce + inrush blanking
│   ├── fsm.cpp/h           # Self-healing FSM with thermal guard
│   ├── relay_control.cpp/h # Dual relay with bootloader-safe init
│   ├── led_alert.cpp/h     # Blink patterns per FSM state
│   ├── buzzer.cpp/h        # PWM patterns via LEDC
│   ├── oled_display.cpp/h  # 2-page SSD1306 display
│   ├── nvs_log.cpp/h       # 50-entry NVS ring buffer
│   ├── wifi_manager.cpp/h  # Captive portal provisioning
│   ├── api_server.cpp/h    # REST API with CORS + API-key auth
│   └── mqtt_client.cpp/h   # MQTT telemetry publisher
├── dashboard/
│   └── index.html          # Standalone dashboard (host anywhere)
├── platformio.ini
├── .gitignore
└── README.md
```

---

## 1 — Flash the Firmware

### Prerequisites
- [VSCode](https://code.visualstudio.com/)
- [PlatformIO IDE extension](https://marketplace.visualstudio.com/items?itemName=platformio.platformio-ide)
- [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) *(optional — AI assistance)*

### Steps
```bash
# Clone the repo (after you push it — see section 3)
git clone https://github.com/YOUR_USERNAME/smart-grid-sentinel.git
cd smart-grid-sentinel

# Open in VSCode
code .

# In VSCode:
#   1. PlatformIO sidebar → Build  (Ctrl+Alt+B)
#   2. PlatformIO sidebar → Upload (Ctrl+Alt+U)
#   3. PlatformIO sidebar → Serial Monitor (115200 baud)
```

The first line printed after boot is the **API key** — copy it, you need it for the dashboard.

---

## 2 — First Boot & Wi-Fi Setup

1. Power the ESP32
2. OLED shows: `SGS-SETUP`
3. Connect phone/laptop to Wi-Fi network: `SGS-Setup` (password: `sgs-setup-1234`)
4. Browser opens captive portal at `192.168.4.1`
5. Enter your network SSID + password → Save
6. ESP32 reboots → OLED shows IP address
7. Open `http://<IP>/api/ping` to confirm it's live

---

## 3 — Push to GitHub

```bash
cd sgs/

# Initialise git (if not already done)
git init
git add .
git commit -m "feat: initial SGS demo firmware"

# Create repo on GitHub (requires GitHub CLI — brew install gh / apt install gh)
gh repo create smart-grid-sentinel --public --source=. --remote=origin --push

# OR — manually create repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/smart-grid-sentinel.git
git branch -M main
git push -u origin main
```

### Subsequent syncs
```bash
git add .
git commit -m "fix: improved inrush blanking threshold"
git push
```

VSCode syncs automatically — bottom-left shows branch + pending commits. Click to sync.

---

## 4 — VSCode + PlatformIO Workflow

| Action               | Shortcut / Where                          |
|----------------------|-------------------------------------------|
| Build                | `Ctrl+Alt+B` or PlatformIO sidebar → Build|
| Upload               | `Ctrl+Alt+U` or PlatformIO sidebar → Upload|
| Serial monitor       | PlatformIO sidebar → Monitor             |
| Clean build          | PlatformIO sidebar → Clean               |
| Git commit           | Source Control panel (`Ctrl+Shift+G`)    |
| Git push/pull        | Source Control → ··· menu → Push / Pull  |

---

## 5 — Claude Code Extension (VSCode)

The [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) 
gives you AI assistance directly inside VSCode, aware of your full codebase.

### Install
```
Ctrl+Shift+X → search "Claude Code" → Install
```

### Useful prompts in this codebase
```
"Add a power factor measurement to SensorReading and publish it in the MQTT payload"

"Increase INRUSH_BLANK_MS to 800 and explain what loads that covers"

"Add an /api/health endpoint that returns stack HWM and free heap"

"Why might the OLED display freeze — check the I2C blocking calls in oled_display.cpp"
```

Claude Code has access to all your files in the workspace, so it understands the full 
module structure and will give answers specific to this codebase.

---

## 6 — Dashboard Hosting Options

The `dashboard/index.html` is a single self-contained file. No build step. Deploy anywhere:

| Option         | Command / Steps                                              |
|----------------|--------------------------------------------------------------|
| **Local**      | `Open dashboard/index.html in browser` — enter ESP32 IP     |
| **GitHub Pages** | Push to `gh-pages` branch, enable Pages in repo settings  |
| **Netlify**    | Drag `dashboard/` folder to netlify.com/drop                |
| **Vercel**     | `npx vercel dashboard/`                                      |

> **CORS note:** The ESP32 API includes `Access-Control-Allow-Origin: *` so the dashboard 
> can be hosted on any domain and still reach the ESP32 directly.

---

## 7 — MQTT Cloud (optional)

Default broker: `broker.hivemq.com:1883` (public, no auth, for demo only).

Topics published:
- `sgs/telemetry` — sensor data every 5 s
- `sgs/fault` — immediate on fault/lockout
- `sgs/state` — every FSM state transition

To use your own broker, navigate to `http://<ESP32-IP>/api` and POST config, or set 
`MQTT_DEFAULT_HOST` / `MQTT_DEFAULT_PORT` in `config.h` before flashing.

---

## API Reference

| Method | Endpoint         | Auth | Description                       |
|--------|-----------------|------|-----------------------------------|
| GET    | `/api/ping`     | No   | Health check                      |
| GET    | `/api/state`    | No   | Full sensor + FSM snapshot (JSON) |
| GET    | `/api/log`      | No   | Last 50 NVS event log entries     |
| GET    | `/api/config`   | No   | Fault thresholds                  |
| POST   | `/api/reset`    | Yes  | Request FSM reset (thermal guard) |
| POST   | `/api/log/clear`| Yes  | Wipe NVS log                      |

Auth: add header `X-API-Key: <key>` — key printed on Serial at first boot.
