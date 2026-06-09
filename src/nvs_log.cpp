// ============================================================
//  nvs_log.cpp — NVS ring-buffer event log
//  Uses Preferences library. Keys: "log_e0" … "log_e49"
//  head = index to write next; count = entries filled so far
// ============================================================
#include "nvs_log.h"
#include "config.h"
#include "serial_log.h"
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

namespace {
    Preferences prefs;
    int log_head  = 0;
    int log_count = 0;

    // NEW-10: mutex guards append/getEntry/clear against concurrent callers
    // (FSM::tick() on Core 0, API handlers on Core 1 lwIP context).
    static SemaphoreHandle_t s_nvs_mtx = nullptr;

    String entryKey(int idx) {
        return String(NVS_KEY_LOG_ENTRY) + String(idx);
    }
}

namespace NVSLog {

    void init() {
        // Create mutex before any task can call append()
        s_nvs_mtx = xSemaphoreCreateMutex();
        // If allocation fails on a healthy ESP32 boot heap this is fatal
        configASSERT(s_nvs_mtx != nullptr);

        prefs.begin(NVS_NAMESPACE, false);
        log_head  = prefs.getInt(NVS_KEY_LOG_HEAD,  0);
        log_count = prefs.getInt(NVS_KEY_LOG_COUNT, 0);
        LOG_NVS("restored %d entries, head=%d", log_count, log_head);
        prefs.end();
    }

    void append(EventEntry e) {
        // BUG-10/22 FIX: Extended mutex timeout from 20ms to 200ms.
        // NVS page flushes can take 50-150ms on fragmented partitions.
        // A 20ms timeout caused silent drops of fault events during
        // back-to-back trips, losing critical diagnostic history.
        if (!s_nvs_mtx || xSemaphoreTake(s_nvs_mtx, pdMS_TO_TICKS(200)) != pdTRUE) return;

        // BUG-22 FIX: Check prefs.begin() return value. If the NVS
        // partition is corrupted or locked by another task, begin()
        // returns false and all subsequent put/get calls silently fail.
        if (!prefs.begin(NVS_NAMESPACE, false)) {
            xSemaphoreGive(s_nvs_mtx);
            return;
        }

        // Write entry as binary blob
        prefs.putBytes(entryKey(log_head).c_str(), &e, sizeof(EventEntry));

        log_head = (log_head + 1) % EVENT_LOG_CAPACITY;
        if (log_count < EVENT_LOG_CAPACITY) log_count++;

        prefs.putInt(NVS_KEY_LOG_HEAD,  log_head);
        prefs.putInt(NVS_KEY_LOG_COUNT, log_count);
        prefs.end();

        xSemaphoreGive(s_nvs_mtx);
    }

    int count() { return log_count; }

    bool getEntry(int idx, EventEntry& out) {
        // idx=0 → oldest entry
        if (idx < 0 || idx >= log_count) return false;

        if (!s_nvs_mtx || xSemaphoreTake(s_nvs_mtx, pdMS_TO_TICKS(200)) != pdTRUE) return false;

        int capacity = EVENT_LOG_CAPACITY;
        int oldest;
        if (log_count < capacity) {
            oldest = 0;
        } else {
            oldest = log_head;  // head points to oldest when full
        }

        int slot = (oldest + idx) % capacity;
        if (!prefs.begin(NVS_NAMESPACE, true)) {  // read-only
            xSemaphoreGive(s_nvs_mtx);
            return false;
        }
        bool ok = prefs.getBytes(entryKey(slot).c_str(), &out, sizeof(EventEntry))
                  == sizeof(EventEntry);
        prefs.end();

        xSemaphoreGive(s_nvs_mtx);
        return ok;
    }

    void clear() {
        if (!s_nvs_mtx || xSemaphoreTake(s_nvs_mtx, pdMS_TO_TICKS(200)) != pdTRUE) return;

        if (!prefs.begin(NVS_NAMESPACE, false)) {
            xSemaphoreGive(s_nvs_mtx);
            return;
        }
        for (int i = 0; i < EVENT_LOG_CAPACITY; i++) {
            prefs.remove(entryKey(i).c_str());
        }
        log_head  = 0;
        log_count = 0;
        prefs.putInt(NVS_KEY_LOG_HEAD,  0);
        prefs.putInt(NVS_KEY_LOG_COUNT, 0);
        prefs.end();
        LOG_NVS("cleared");

        xSemaphoreGive(s_nvs_mtx);
    }
}
