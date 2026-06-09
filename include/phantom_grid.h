#pragma once
#include <atomic>
#include <cstdint>

// ─── Lock-Free Physics Engine Command Queue ─────────────────────────────
// Core 1 (HTTP API / WebSockets) sends commands to Core 0 (Protection Task)
// using these strictly ordered lock-free atomic variables. 
// This fully eliminates Mutex-induced memory tearing and RTOS blocking panics.

enum class SilCommand : uint32_t {
    IDLE = 0,
    NORMAL_GRID = 1,
    MOTOR_START = 2,
    MOTOR_STOP = 3,
    TRIGGER_SAG = 4,
    TRIGGER_SWELL = 5,
    ENABLE_FLICKER = 6,
    DISABLE_FLICKER = 7,
    DISABLE_SIMULATION = 8,
    CUSTOM_LOAD = 9
};

// Parameter slots (written with memory_order_relaxed BEFORE the command)
extern std::atomic<float> g_sil_param1;
extern std::atomic<float> g_sil_param2;

// Command trigger (written with memory_order_release, read with memory_order_acquire)
extern std::atomic<SilCommand> g_sil_cmd;

struct HIL_Cmd {
    std::atomic<bool> test_ready{false};
    float target_voltage;
    float target_current;
    bool trigger_motor;
    int ticks;
};

extern HIL_Cmd hil_cmd;
