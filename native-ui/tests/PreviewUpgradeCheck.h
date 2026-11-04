#pragma once
#include <QStringList>

// An explicit disposable owner, separate from the production --workspace entry.
// It speaks the existing V4 transport to the selected frozen production backend.
namespace PreviewUpgradeCheck {
bool requested(const QStringList &arguments);
int run(int argc, char **argv);
}
