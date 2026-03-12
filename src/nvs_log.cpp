// ============================================================
//  nvs_log.cpp — NVS ring-buffer event log
//  Uses Preferences library. Keys: "log_e0" … "log_e49"
//  head = index to write next; count = entries filled so far
// ============================================================
#include "nvs_log.h"
#include "config.h"
#include <Preferences.h>

namespace {
    Preferences prefs;
    int log_head  = 0;
    int log_count = 0;

    String entryKey(int idx) {
        return String(NVS_KEY_LOG_ENTRY) + String(idx);
    }
}

namespace NVSLog {

    void init() {
        prefs.begin(NVS_NAMESPACE, false);
        log_head  = prefs.getInt(NVS_KEY_LOG_HEAD,  0);
        log_count = prefs.getInt(NVS_KEY_LOG_COUNT, 0);
        Serial.printf("[NVS_LOG] restored %d entries, head=%d\n", log_count, log_head);
        prefs.end();
    }

    void append(EventEntry e) {
        prefs.begin(NVS_NAMESPACE, false);

        // Write entry as binary blob
        prefs.putBytes(entryKey(log_head).c_str(), &e, sizeof(EventEntry));

        log_head = (log_head + 1) % EVENT_LOG_CAPACITY;
        if (log_count < EVENT_LOG_CAPACITY) log_count++;

        prefs.putInt(NVS_KEY_LOG_HEAD,  log_head);
        prefs.putInt(NVS_KEY_LOG_COUNT, log_count);
        prefs.end();
    }

    int count() { return log_count; }

    bool getEntry(int idx, EventEntry& out) {
        // idx=0 → oldest entry
        if (idx < 0 || idx >= log_count) return false;

        int capacity = EVENT_LOG_CAPACITY;
        int oldest;
        if (log_count < capacity) {
            oldest = 0;
        } else {
            oldest = log_head;  // head points to oldest when full
        }

        int slot = (oldest + idx) % capacity;
        prefs.begin(NVS_NAMESPACE, true);  // read-only
        bool ok = prefs.getBytes(entryKey(slot).c_str(), &out, sizeof(EventEntry))
                  == sizeof(EventEntry);
        prefs.end();
        return ok;
    }

    void clear() {
        prefs.begin(NVS_NAMESPACE, false);
        for (int i = 0; i < EVENT_LOG_CAPACITY; i++) {
            prefs.remove(entryKey(i).c_str());
        }
        log_head  = 0;
        log_count = 0;
        prefs.putInt(NVS_KEY_LOG_HEAD,  0);
        prefs.putInt(NVS_KEY_LOG_COUNT, 0);
        prefs.end();
        Serial.println("[NVS_LOG] cleared");
    }
}
