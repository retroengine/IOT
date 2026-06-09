-- ================================================================
--  SGS Analytics Schema — Supabase SQL Migration
--  Run this in: Supabase Dashboard → SQL Editor → New Query → Run
--
--  Creates 4 tables:
--    telemetry_snapshots  — 1 row per minute, all sensor readings
--    fault_events         — 1 row per FSM state transition
--    energy_daily         — 1 row per device per day (rollup)
--    mqtt_events          — connection lifecycle events
-- ================================================================

-- ── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ── 1. telemetry_snapshots ────────────────────────────────────────────────────
-- Sampled every 60 seconds. ~1,440 rows/day/device. 500MB DB ≈ 2+ years.
create table if not exists telemetry_snapshots (
  id              uuid        primary key default uuid_generate_v4(),
  device_id       text        not null default 'sgs-device-01',
  ts              timestamptz not null default now(),   -- exact UTC timestamp with timezone

  -- Primary electrical measurements
  voltage_v       numeric(8,3),    -- filtered voltage (V)
  current_a       numeric(8,3),    -- filtered current (A)
  temperature_c   numeric(6,2),    -- temperature (°C)
  power_w         numeric(10,2),   -- real power (W)
  apparent_va     numeric(10,2),   -- apparent power (VA)
  energy_wh       numeric(12,3),   -- cumulative energy since boot (Wh)
  power_factor    numeric(5,4),    -- 0.0000–1.0000
  frequency_hz    numeric(5,2),    -- grid frequency (Hz)

  -- Protection status
  fsm_state       text,            -- BOOT|NORMAL|WARNING|FAULT|RECOVERY|LOCKOUT
  health_score    integer,         -- 0–100
  relay_on        boolean,         -- relay1 state
  trip_count      integer,         -- cumulative trips since boot
  fault_code      text,            -- NONE|OVERVOLTAGE|OVERCURRENT|...

  -- Network vitals
  wifi_rssi       integer,         -- dBm (-120..0)
  mqtt_connected  boolean,

  -- System vitals
  free_heap       integer,         -- bytes
  uptime_s        integer,         -- seconds since boot
  cpu_load_pct    numeric(5,2),    -- estimated CPU %

  -- Meta (source of data: esp32ws | esp32http | mqtt | mock)
  source          text,
  schema_v        text default '1.3',

  created_at      timestamptz not null default now()
);

-- ── 2. fault_events ───────────────────────────────────────────────────────────
-- Written immediately on every FSM state transition.
create table if not exists fault_events (
  id                  uuid        primary key default uuid_generate_v4(),
  device_id           text        not null default 'sgs-device-01',
  ts                  timestamptz not null default now(),

  from_state          text,        -- previous FSM state
  to_state            text,        -- new FSM state
  fault_code          text,        -- active fault at time of transition
  trip_count          integer,     -- total trips at this moment
  voltage_v           numeric(8,3),
  current_a           numeric(8,3),
  temperature_c       numeric(6,2),
  power_w             numeric(10,2),
  fault_probability   numeric(5,2),-- 0–100 %
  risk_level          text,        -- LOW|MODERATE|HIGH|CRITICAL
  health_score        integer,

  source              text,
  created_at          timestamptz not null default now()
);

-- ── 3. energy_daily ───────────────────────────────────────────────────────────
-- One row per device per UTC day. Updated (upserted) hourly by relay server.
create table if not exists energy_daily (
  id                uuid        primary key default uuid_generate_v4(),
  device_id         text        not null default 'sgs-device-01',
  date              date        not null,              -- UTC date

  energy_wh_total   numeric(12,3),   -- total energy that day
  peak_voltage_v    numeric(8,3),    -- max voltage seen that day
  min_voltage_v     numeric(8,3),    -- min voltage seen that day
  avg_power_w       numeric(10,2),   -- average real power
  avg_current_a     numeric(8,3),
  avg_temperature_c numeric(6,2),
  uptime_s          integer,         -- total uptime recorded that day
  fault_count       integer default 0,  -- number of FAULT transitions
  trip_count_end    integer,         -- trip_count at end of day
  sample_count      integer default 0,  -- rows averaged (for avg fields)

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique(device_id, date)
);

-- ── 4. mqtt_events ────────────────────────────────────────────────────────────
-- Connection lifecycle events for connectivity analysis.
create table if not exists mqtt_events (
  id              uuid        primary key default uuid_generate_v4(),
  device_id       text        not null default 'sgs-device-01',
  ts              timestamptz not null default now(),

  event_type      text,        -- 'connected'|'disconnected'|'publish_failed'|'reconnect'
  reconnect_count integer,
  publish_total   integer,
  publish_failed  integer,
  broker          text,
  error_msg       text,

  created_at      timestamptz not null default now()
);

-- ── Indexes (critical for time-range queries) ────────────────────────────────
create index if not exists idx_telemetry_device_ts
  on telemetry_snapshots (device_id, ts desc);

create index if not exists idx_telemetry_ts
  on telemetry_snapshots (ts desc);

create index if not exists idx_faults_device_ts
  on fault_events (device_id, ts desc);

create index if not exists idx_energy_device_date
  on energy_daily (device_id, date desc);

create index if not exists idx_mqtt_events_ts
  on mqtt_events (device_id, ts desc);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Disable RLS so anon key can read/write (personal IoT project).
-- Re-enable and add policies if you share this dashboard publicly.
alter table telemetry_snapshots disable row level security;
alter table fault_events        disable row level security;
alter table energy_daily        disable row level security;
alter table mqtt_events         disable row level security;

-- ── Convenience views ─────────────────────────────────────────────────────────

-- Last 24h telemetry at 10-minute buckets (for quick analytics)
create or replace view telemetry_10min as
select
  device_id,
  date_trunc('hour', ts) + (extract(minute from ts)::int / 10) * interval '10 min' as bucket,
  round(avg(voltage_v)::numeric,     3) as avg_voltage_v,
  round(avg(current_a)::numeric,     3) as avg_current_a,
  round(avg(temperature_c)::numeric, 2) as avg_temperature_c,
  round(avg(power_w)::numeric,       2) as avg_power_w,
  round(avg(health_score)::numeric,  1) as avg_health,
  count(*)                               as samples
from telemetry_snapshots
where ts > now() - interval '24 hours'
group by device_id, bucket
order by bucket desc;

-- Fault rate by hour (last 7 days)
create or replace view fault_rate_hourly as
select
  device_id,
  date_trunc('hour', ts) as hour,
  count(*) as fault_count,
  count(*) filter (where to_state = 'FAULT')    as faults,
  count(*) filter (where to_state = 'LOCKOUT')  as lockouts,
  count(*) filter (where to_state = 'RECOVERY') as recoveries
from fault_events
where ts > now() - interval '7 days'
group by device_id, hour
order by hour desc;
