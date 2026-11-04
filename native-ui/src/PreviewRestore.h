#pragma once

#include "PreviewSnapshot.h"

namespace PreviewRestore {
// Caller holds the Session lock. Recovery must run before Session creates data
// children, before compatibility checks, and before any backend/avatar helper.
// Every still-present data generation is checked before recovery writes. Format
// errors propagate unchanged; indeterminate identities preserve the transaction.
void recoverPending(const PreviewWorkspace::Session &,
                    std::shared_ptr<PreviewSnapshot::FileOperations> = {},
                    const QStringList &protectedSnapshots = {});
QJsonArray listSnapshots(const PreviewWorkspace::Session &);
QJsonObject restore(const PreviewWorkspace::Session &, const QString &snapshotName,
                    const PreviewSnapshot::Identity &currentIdentity,
                    std::shared_ptr<PreviewSnapshot::FileOperations> = {});
} // namespace PreviewRestore
