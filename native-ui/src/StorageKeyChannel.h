#pragma once

#include <QByteArray>
#include <QtGlobal>
#include <memory>

class QProcess;

// A single-use inherited channel for storage key bytes, separate from stdio
// and the bridge authentication secret. Platform handles remain private.
class StorageKeyChannel final {
public:
    explicit StorageKeyChannel(const char *creationFailureCode);
    ~StorageKeyChannel();
    StorageKeyChannel(const StorageKeyChannel &) = delete;
    StorageKeyChannel &operator=(const StorageKeyChannel &) = delete;

    void configureChild(QProcess &process) const;
    qint64 sendAndClose(const QByteArray &key);

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
