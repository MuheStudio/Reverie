#import <AppKit/AppKit.h>

// The preview never shows a window: keep it out of the Dock and never let it
// take activation from the user's foreground application.
void previewProhibitActivation() {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
}
