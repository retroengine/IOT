#include <stdio.h>
#include <stdlib.h>

int main() {
    float f = atof("0.5,\"duration\":2}");
    printf("%f\n", f);
    return 0;
}
