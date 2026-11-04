#pragma once
#include <QString>
namespace PreviewStartupPolicy {
inline QString notice(bool preview, const QString &code) {
    if (preview && (code == QStringLiteral("KEYCHAIN_UNAVAILABLE") ||
                    code == QStringLiteral("KEYCHAIN_KEY_INVALID") ||
                    code == QStringLiteral("KEY_MISSING_EXISTING_DATABASE")))
        return QStringLiteral("无法从钥匙串读取存储密钥，预览没有启动，数据没有改动");
    return QStringLiteral("启动被安全拒绝：%1").arg(code);
}
}
