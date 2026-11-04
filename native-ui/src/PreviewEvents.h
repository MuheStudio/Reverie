#pragma once
#include <QElapsedTimer>
#include <QJsonObject>
#include <QList>
#include <QString>

namespace PreviewWorkspace { class Session; }
namespace PreviewEvents {
inline constexpr qint64 MaximumBytes = 65536;
inline constexpr int MaximumRecords = 128;
QString normalizedCode(const QString &);
bool knownEvent(const QString &);
QString startupNotice(bool preview, const QString &code);
class Writer final {
public:
    explicit Writer(const PreviewWorkspace::Session &);
    ~Writer();
    Writer(const Writer &) = delete;
    Writer &operator=(const Writer &) = delete;
    // Only a live lock-owning Session can construct this writer. Errors are
    // fixed codes; neither caller text nor paths are serialized.
    void record(const QString &event, const QString &code = QStringLiteral("OK"), qint64 value = 0);
private:
    QString m_root;
    QList<QByteArray> m_records;
    QElapsedTimer m_clock;
    qint64 m_sequence = 0;
    int m_directory = -1;
};
} // namespace PreviewEvents
