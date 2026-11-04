#pragma once
#include "ArchiveInputProbe.h"
#include "CheckContract.h"
#include <QKeySequence>
#include <QLocale>
#include <QSignalSpy>
#include <QTest>
#include <cmath>
#include <functional>

// The GUI driver and the real-host cases dispatch this same input path. The
// caller retains reveal/stability/scope qualification and its original clock;
// this helper never sets a value, selects text, pumps events, or retries.
namespace WorldbookInjectionInput {
struct Context {
    QPointer<QObject> editor;
    std::function<QQuickItem *()> resolveTarget;
    std::function<QVariant()> editorValue;
    std::function<bool()> baselineReady;
    std::function<QVariantMap()> metadata;
    std::function<QPoint(const QString &, bool)> qualify;
    std::function<void(const QVariantMap &)> publish;
    // Optional injection-only observer dispatch. Existing native raw producers
    // leave this unset and retain the original QTest call and evidence schema.
    std::function<void(const QPoint &)> mouseDispatch;
};

inline QVariantMap identity(const QObject *object) {
    return {{"found", object != nullptr}, {"objectName", object ? object->objectName().left(80) : QString()},
        {"className", object ? QString::fromLatin1(object->metaObject()->className()).left(80) : QString()},
        {"token", object ? QString::number(reinterpret_cast<quintptr>(object), 16) : QString()}};
}
inline QQuickItem *editableTextInput(QQuickItem *control) {
    auto *content = control ? control->property("contentItem").value<QQuickItem *>() : nullptr;
    return content && content->inherits("QQuickTextInput") && control->isAncestorOf(content) ? content : nullptr;
}
inline QVariant integerProperty(const QObject *object, const char *name) {
    const auto value = object ? object->property(name) : QVariant();
    return value.metaType().id() == QMetaType::Int ? value : QVariant();
}
inline bool numericDepth(const QVariant &value) {
    const auto type = value.metaType().id();
    if (type != QMetaType::Int && type != QMetaType::UInt && type != QMetaType::LongLong &&
        type != QMetaType::ULongLong && type != QMetaType::Double) return false;
    const double number = value.toDouble();
    return std::isfinite(number) && number >= 0 && number <= 200 && std::floor(number) == number;
}
inline QVariantList sequenceCodes(const QKeySequence &sequence) {
    QVariantList values;
    for (int index = 0; index < sequence.count(); ++index) values.append(sequence[index].toCombined());
    return values;
}
inline bool fullSelection(const QVariantMap &sample) {
    return sample.value("propertiesValid").toBool() && sample.value("selectionBoundsValid").toBool() &&
        sample.value("textLength").toInt() > 0 && sample.value("selectionStart").toInt() == 0 &&
        sample.value("selectionEnd") == sample.value("textLength") &&
        sample.value("selectedTextLength") == sample.value("textLength");
}
inline QVariantMap snapshot(const Context &context, QQuickWindow *window, QQuickItem *target,
                            QQuickItem *boundEditable, const QString &phase, const QVariant &signalCount,
                            int mouseDispatchCount, int keyDispatchCount) {
    const auto caller = context.metadata();
    auto *editable = editableTextInput(target);
    auto *focus = window ? window->activeFocusItem() : nullptr;
    const auto text = editable ? editable->property("text") : QVariant();
    const auto selected = editable ? editable->property("selectedText") : QVariant();
    const auto start = integerProperty(editable, "selectionStart"), end = integerProperty(editable, "selectionEnd");
    const auto cursor = integerProperty(editable, "cursorPosition");
    const auto controlValue = integerProperty(target, "value");
    const auto editorValue = context.editorValue();
    const bool textValid = text.metaType().id() == QMetaType::QString;
    const bool selectedValid = selected.metaType().id() == QMetaType::QString;
    const bool propertiesValid = target && editable && context.editor && textValid && selectedValid &&
        start.isValid() && end.isValid() && cursor.isValid() && controlValue.isValid() &&
        numericDepth(editorValue);
    const int length = textValid ? text.toString().size() : 0;
    const bool boundsValid = propertiesValid && start.toInt() >= 0 && end.toInt() >= start.toInt() &&
        end.toInt() <= length && cursor.toInt() >= 0 && cursor.toInt() <= length &&
        selected.toString().size() == end.toInt() - start.toInt();
    bool numeric = false;
    const auto locale = target ? target->property("locale").value<QLocale>() : QLocale();
    const int editableValue = textValid ? locale.toInt(text.toString(), &numeric) : 0;
    QVariantMap out{{"phase", phase}, {"capturePoint", "before-boundary-assertion"},
        {"target", identity(target)}, {"editableTextInput", identity(editable)}, {"focus", identity(focus)},
        {"editor", identity(context.editor)}, {"controlObjectName", target ? target->objectName() : QString()},
        {"targetMatchesBound", target && context.resolveTarget() == target},
        {"editableMatchesBound", editable && editable == boundEditable},
        {"focusInTarget", ArchiveInputProbe::keyboardFocusMatches(target, window)},
        {"focusInEditable", editable && focus == editable}, {"propertiesValid", propertiesValid},
        {"selectionBoundsValid", boundsValid}, {"textLength", textValid ? QVariant(length) : QVariant()},
        {"cursorPosition", cursor}, {"selectionStart", start}, {"selectionEnd", end},
        {"selectedTextLength", selectedValid ? QVariant(selected.toString().size()) : QVariant()},
        {"textNumeric", numeric}, {"editableValue", numeric ? QVariant(editableValue) : QVariant()},
        {"controlValue", controlValue}, {"editorValue", editorValue}, {"valueModifiedSignals", signalCount},
        {"mouseDispatchCount", mouseDispatchCount}, {"keyDispatchCount", keyDispatchCount}};
    for (const auto *key : {"nowMs", "elapsedMs", "stepAtMs", "inputAtMs", "scope", "generation", "step", "frame", "selectedEntryId"})
        out[key] = caller.value(key);
    out["fullSelection"] = fullSelection(out);
    return out;
}

inline QVariantMap replaceDepth(QQuickWindow *window, QQuickItem *control, int expectedValue, const Context &context) {
    QPointer<QQuickItem> target = control, editable = editableTextInput(control);
    QSignalSpy modified(control, SIGNAL(valueModified()));
    const QKeySequence standard(QKeySequence::SelectAll);
    const auto bindings = QKeySequence::keyBindings(QKeySequence::SelectAll);
    const int bindingIndex = int(bindings.indexOf(standard));
    const QKeySequence dispatched = standard;
    const auto caller = context.metadata();
    const auto before = integerProperty(control, "value");
    QVariantMap evidence{{"schema", "reverie.qt.worldbook-injection-depth-input.v1"}, {"expectedValue", expectedValue},
        {"beforeValue", before}, {"controlObjectName", control ? control->objectName() : QString()},
        {"standardKey", "SelectAll"}, {"sequenceMatchesStandardKey", bindingIndex >= 0 && dispatched == bindings.value(bindingIndex)},
        {"standardBindingIndex", bindingIndex}, {"dispatchedSequenceCodes", sequenceCodes(dispatched)},
        {"standardSequenceCodes", sequenceCodes(standard)},
        {"dispatchedSequencePortableText", dispatched.toString(QKeySequence::PortableText)},
        {"standardSequencePortableText", standard.toString(QKeySequence::PortableText)},
        {"completed", false}};
    for (const auto *key : {"step", "stepAtMs", "inputAtMs", "selectedEntryId", "scope", "generation"})
        evidence[key] = caller.value(key);
    QVariantList samples;
    QStringList keys;
    int mouseDispatchCount = 0, keyDispatchCount = 0;
    const auto capture = [&](const QString &phase) {
        const auto signalCount = modified.isValid() ? QVariant::fromValue(qint64(modified.count())) : QVariant();
        const auto sample = snapshot(context, window, target, editable, phase, signalCount, mouseDispatchCount, keyDispatchCount);
        samples.append(sample);
        evidence.insert({{"snapshots", samples}, {"mouseDispatchCount", mouseDispatchCount},
            {"keyDispatchCount", keyDispatchCount}, {"keyActions", keys}, {"valueModifiedSignals", signalCount}});
        // Publish before every assertion, including failed attempts. Only eight
        // fixed boundary snapshots are taken; no text is copied into evidence.
        context.publish(evidence);
        return sample;
    };
    const auto require = [&](bool ok, const QString &code) { NativeCheck::require(ok, code, evidence); };
    const auto valid = [](const QVariantMap &sample) {
        return sample.value("targetMatchesBound").toBool() && sample.value("editableMatchesBound").toBool() &&
            sample.value("propertiesValid").toBool() && sample.value("selectionBoundsValid").toBool();
    };
    const auto focused = [&](const QVariantMap &sample) {
        return valid(sample) && sample.value("focusInTarget").toBool() && sample.value("focusInEditable").toBool();
    };
    const auto unchanged = [&](const QVariantMap &sample) {
        return sample.value("controlValue") == before && sample.value("editorValue") == before &&
            sample.value("valueModifiedSignals") == QVariant(0);
    };
    auto sample = capture("before-click");
    require(window && target && editable && modified.isValid() && valid(sample), "INJECTION_DEPTH_TARGET");
    require(expectedValue >= 0 && expectedValue <= 9 && before.isValid() && before != QVariant(expectedValue) &&
        context.baselineReady() && unchanged(sample) && sample.value("textNumeric").toBool() &&
        sample.value("editableValue") == before && sample.value("textLength") == QVariant(1), "INJECTION_DEPTH_BASELINE");
    require(bindingIndex >= 0 && standard.count() == 1 && dispatched.count() == 1 &&
        evidence.value("sequenceMatchesStandardKey").toBool(), "INJECTION_DEPTH_STANDARD_KEY");
    const QPoint point = context.qualify("before-click", false);
    ++mouseDispatchCount;
    if (context.mouseDispatch) context.mouseDispatch(point);
    else QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, point, 0);
    sample = capture("after-click");
    require(focused(sample) && unchanged(sample), "INJECTION_DEPTH_CLICK");

    sample = capture("before-select-all");
    require(focused(sample) && unchanged(sample), "INJECTION_DEPTH_SELECT_TARGET");
    context.qualify("before-select-all", true);
    ++keyDispatchCount; keys.append("SelectAll");
    QTest::keySequence(window, dispatched);
    sample = capture("after-select-all");
    require(focused(sample) && unchanged(sample) && fullSelection(sample), "INJECTION_DEPTH_SELECTION");

    sample = capture("before-digit");
    require(focused(sample) && unchanged(sample) && fullSelection(sample), "INJECTION_DEPTH_SELECTION");
    context.qualify("before-digit", true);
    ++keyDispatchCount; keys.append(QString("Digit%1").arg(expectedValue));
    QTest::keyClick(window, static_cast<Qt::Key>(Qt::Key_0 + expectedValue), Qt::NoModifier, 0);
    sample = capture("after-digit");
    const auto replaced = [&](const QVariantMap &value) {
        return focused(value) && value.value("textLength") == QVariant(1) && value.value("textNumeric").toBool() &&
            value.value("editableValue") == QVariant(expectedValue) && value.value("selectedTextLength") == QVariant(0) &&
            value.value("selectionStart") == value.value("selectionEnd") &&
            value.value("cursorPosition") == value.value("textLength") &&
            value.value("controlValue") == value.value("editorValue") &&
            (value.value("controlValue") == before || value.value("controlValue") == QVariant(expectedValue)) &&
            value.value("valueModifiedSignals").metaType().id() == QMetaType::LongLong &&
            value.value("valueModifiedSignals").toLongLong() >= 0 && value.value("valueModifiedSignals").toLongLong() <= 1;
    };
    require(replaced(sample), "INJECTION_DEPTH_REPLACEMENT");

    sample = capture("before-commit");
    require(replaced(sample), "INJECTION_DEPTH_REPLACEMENT");
    context.qualify("before-commit", true);
    ++keyDispatchCount; keys.append("Return");
    QTest::keyClick(window, Qt::Key_Return, Qt::NoModifier, 0);
    sample = capture("after-commit");
    require(replaced(sample) && sample.value("controlValue") == QVariant(expectedValue) &&
        sample.value("editorValue") == QVariant(expectedValue) && modified.count() == 1 &&
        mouseDispatchCount == 1 && keyDispatchCount == 3, "INJECTION_DEPTH_INPUT");
    evidence["completed"] = true;
    context.publish(evidence);
    return evidence;
}
} // namespace WorldbookInjectionInput
