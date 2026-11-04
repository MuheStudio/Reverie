#pragma once
#include <QByteArray>
#include <QString>

// Only extracts local untrusted data. Semantic validation and all persistence
// remain with the existing backend importer.
namespace PersonaCardReader {
struct Card {
    QString json, filename, name, sourceFormat, targetId, error;
    bool valid() const { return error.isEmpty() && !json.isEmpty(); }
};
Card readFile(const QString &path);
Card parseBytes(const QByteArray &bytes, const QString &filename);
}
