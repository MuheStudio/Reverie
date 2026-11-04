#pragma once

#include <QObject>
#include <QString>
#include <QVariantMap>
#include <memory>

class QQuickWindow;

// Opt-in test evidence only. Captures the supplied Qt window's render result;
// it never captures the display or uses the system screen-recording service.
class WindowRecorder final : public QObject {
  public:
    explicit WindowRecorder(QQuickWindow *window, QObject *parent = nullptr);
    ~WindowRecorder() override;

    bool start(QString file);
    QVariantMap finish();
    QString error() const;
    quint64 frames() const;
    double duration() const;
    int width() const;
    int height() const;

  private:
    struct Private;
    std::unique_ptr<Private> d;
    void captureFrame();
    void fail(const QString &message);
    QVariantMap result() const;
};
