#include <stdio.h>
#include <string.h>

int main() {
    const char* buf = "{\"cmd\":\"sag\",\"depth\":0.3,\"duration\":2.0}";
    const char* p1_loc = strstr(buf, "\"depth\"");
    float p1 = 0.0f;
    if (p1_loc) {
        int res = sscanf(p1_loc, "\"depth\"%*[^0-9.]%f", &p1);
        printf("res=%d p1=%f\n", res, p1);
    }
    return 0;
}
