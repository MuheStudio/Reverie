#pragma once

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <memory>
#include <functional>

class QQuickWindow;
class QEvent;

// Opt-in observations of the existing scene graph. This class never changes a
// texture, item, graphics backend, render loop, window geometry, or frame pacing.
class PerfDiagnostics final : public QObject {
public:
    // diagnostic=false keeps only fixed CPU callback timestamps and one-time
    // context metadata; it performs no texture traversal or GPU timer queries.
    // timingOnly keeps callbacks/phase-lock observations and disables texture,
    // GL/context queries and geometry collection for selected diagnostic cases.
    explicit PerfDiagnostics(bool diagnostic = true, QObject *parent = nullptr, bool timingOnly = false);
    ~PerfDiagnostics() override;

    // Install before the first QQuickWindow is created. The caller enables
    // QSG_INFO only for diagnostic runs. Messages still reach the prior handler.
    static void installMessageCapture();
    static void uninstallMessageCapture();

    // Call on the GUI thread after engine.load(). All QSG and GL access occurs
    // in direct render-thread callbacks with the window's current context.
    bool attach(QQuickWindow *window);
    void setPhase(const QString &phase);
    void refreshTargets();
    // Complete on the GUI thread after live render-thread query retirement.
    // Call before the application starts tearing down its QQuickWindow.
    void stop(std::function<void()> finished = {});
    QJsonObject snapshot() const;

protected:
    bool eventFilter(QObject *watched, QEvent *event) override;

private:
    struct Impl;
    std::shared_ptr<Impl> d;
};
