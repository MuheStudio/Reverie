#pragma once

#include <QJsonValue>
#include <QString>
#include <stdexcept>

namespace PreviewWorkspace { class Session; }
namespace PreviewPlatform { class Handle; }

namespace PreviewDataFormat {
inline constexpr int Current = 1;
inline constexpr int Failure = 71;
inline constexpr auto FileName = "preview-data-format.json";
inline constexpr auto Schema = "reverie.preview.data-format.v1";
class Error final : public std::runtime_error {
public:
    explicit Error(const char *code) : std::runtime_error(code) {}
    const int exitCode = Failure;
};
// An absent field belongs to the first preview release. Never repair an
// installed runtime's metadata merely to supply this legacy default.
int supportedRuntimeValue(const QJsonValue &);
// Read-only, including missing roots/data/records. Unknown formats fail closed.
int checkWorkspace(const QString &root, int supported = Current);
// Recovery resolves a journal's attested live/backup/staging data handle before
// any rename. Missing canonical data must not hide a newer backup format.
int checkDataDirectory(const PreviewPlatform::Handle &, int supported = Current);
// Only the authenticated clean/writable ready path may publish this record.
void writeReady(const PreviewWorkspace::Session &, int format = Current);
QString notice(const QString &code);
} // namespace PreviewDataFormat
