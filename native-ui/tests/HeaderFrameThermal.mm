#include "HeaderFrameThermal.h"

#import <Foundation/NSProcessInfo.h>

namespace HeaderFrameThermal {
QVariantMap snapshot() {
    @autoreleasepool {
        const auto state = NSProcessInfo.processInfo.thermalState;
        const char *name = "unknown";
        switch (state) {
        case NSProcessInfoThermalStateNominal: name = "nominal"; break;
        case NSProcessInfoThermalStateFair: name = "fair"; break;
        case NSProcessInfoThermalStateSerious: name = "serious"; break;
        case NSProcessInfoThermalStateCritical: name = "critical"; break;
        }
        return {{"available", true}, {"state", qlonglong(state)}, {"name", name},
            {"scope", "NSProcessInfo system thermalState at this observation; not temperature, "
                      "CPU/GPU frequency or proof of thermal throttling. Apple's API also returns "
                      "nominal when thermal state is unknown or unsupported."}};
    }
}
}
