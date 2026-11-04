#include "StorageKeyChannel.h"

#include <QProcess>
#include <fcntl.h>
#include <stdexcept>
#include <unistd.h>

struct StorageKeyChannel::Impl {
    int descriptors[2]{-1, -1};
    ~Impl() {
        for (const int descriptor : descriptors)
            if (descriptor >= 0) ::close(descriptor);
    }
};

StorageKeyChannel::StorageKeyChannel(const char *creationFailureCode)
    : m_impl(std::make_unique<Impl>()) {
    if (::pipe(m_impl->descriptors))
        throw std::runtime_error(creationFailureCode);
}

StorageKeyChannel::~StorageKeyChannel() = default;

void StorageKeyChannel::configureChild(QProcess &process) const {
    process.setChildProcessModifier([read = m_impl->descriptors[0], write = m_impl->descriptors[1]] {
        ::close(write);
        if (read != 3) {
            ::dup2(read, 3);
            ::close(read);
        }
        ::fcntl(3, F_SETFD, 0);
    });
}

qint64 StorageKeyChannel::sendAndClose(const QByteArray &key) {
    ::close(m_impl->descriptors[0]);
    m_impl->descriptors[0] = -1;
    const auto count = ::write(m_impl->descriptors[1], key.constData(), size_t(key.size()));
    ::close(m_impl->descriptors[1]);
    m_impl->descriptors[1] = -1;
    return count;
}
