#include "phantom_grid.h"

// Define the atomic SIL command variables for cross-core communication
std::atomic<float>      g_sil_param1(0.0f);
std::atomic<float>      g_sil_param2(0.0f);
std::atomic<SilCommand> g_sil_cmd(SilCommand::IDLE);

HIL_Cmd hil_cmd;
