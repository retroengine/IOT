#pragma once
// ============================================================
//  nvs_log.h — NVS ring-buffer event log
// ============================================================
#include "types.h"

namespace NVSLog {
    void init();
    void append(EventEntry e);   // by value — allows brace-init at call sites
    int  count();
    bool getEntry(int idx, EventEntry& out);  // idx=0 is oldest
    void clear();
}
