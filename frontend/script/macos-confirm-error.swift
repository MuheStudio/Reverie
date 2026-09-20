// Acceptance controller only. Never bundled into the application.
// Confirm an existing, precisely identified fatal alert without launching an app.
import AppKit
import ApplicationServices

struct Request: Decodable {
    let appRoot: String
    let appId: String
    let pid: Int32
    let expectedTitle: String
    let expectedMessage: String
    let expectedExitCode: Int
}

func stop(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count == 2 else { stop("Expected one acceptance request file") }
let request: Request
do { request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) }
catch { stop("Invalid acceptance request; no UI action") }

let expectedRoot = URL(fileURLWithPath: request.appRoot).resolvingSymlinksInPath().path
let expectedURL = URL(fileURLWithPath: expectedRoot)
let testDirectory = expectedURL.deletingLastPathComponent()
let runDirectory = testDirectory.deletingLastPathComponent()
let testRoot = runDirectory.deletingLastPathComponent().path
let allowedTestLocations = [
    ("/private/tmp/Reverie 核心 验收", "只读应用"),
    ("/private/tmp/Reverie DMG 验收", "安装 目录"),
]
let allowedLocation = allowedTestLocations.contains { location in
    let (root, directory) = location
    return testRoot == URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        && testDirectory.lastPathComponent == directory
        && runDirectory.lastPathComponent.hasPrefix("run-")
        && runDirectory.lastPathComponent.count > 4
        && expectedURL.lastPathComponent == "Reverie macOS Test.app"
}
guard request.appId == "com.muhe.reverie.macos.test",
      allowedLocation,
      request.expectedTitle == "Reverie 启动失败",
      request.expectedMessage == "安全初始化未完成，应用将退出。",
      request.expectedExitCode == 1, request.pid > 1 else {
    stop("Request is outside the fatal test-alert contract; no UI action")
}

func isExpectedProcess() -> Bool {
    guard let app = NSRunningApplication(processIdentifier: request.pid) else { return false }
    return app.bundleIdentifier == request.appId
        && app.bundleURL?.resolvingSymlinksInPath().path == expectedRoot
        && app.executableURL?.resolvingSymlinksInPath().path
            == expectedRoot + "/Contents/MacOS/Reverie macOS Test"
}

guard isExpectedProcess() else { stop("Expected test process is absent or changed; no UI action") }
// This read-only check never asks the OS or the user to grant a new permission.
guard AXIsProcessTrusted() else { stop("Existing Accessibility access unavailable; confirm the alert manually", code: 3) }

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return status == .success ? value : nil
}

func inspect(_ element: AXUIElement, depth: Int, texts: inout [String], buttons: inout [AXUIElement]) {
    guard depth <= 12 else { return }
    let role = attribute(element, kAXRoleAttribute) as? String ?? ""
    let title = attribute(element, kAXTitleAttribute) as? String ?? ""
    for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let text = attribute(element, name) as? String { texts.append(text) }
    }
    if role == kAXButtonRole && ["OK", "好", "确定"].contains(title) { buttons.append(element) }
    for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
        inspect(child, depth: depth + 1, texts: &texts, buttons: &buttons)
    }
}

let started = Date()
repeat {
    guard isExpectedProcess() else { stop("Test process exited or changed before confirmation; no UI action") }
    let root = AXUIElementCreateApplication(request.pid)
    let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var matching = [AXUIElement]()
    for window in windows {
        var texts = [String](), buttons = [AXUIElement]()
        inspect(window, depth: 0, texts: &texts, buttons: &buttons)
        if texts.contains(where: { $0.contains(request.expectedTitle) })
            && texts.contains(where: { $0.contains(request.expectedMessage) }) && buttons.count == 1 {
            matching.append(buttons[0])
        }
    }
    if matching.count == 1 {
        guard isExpectedProcess() else { stop("Test process changed before AXPress; no UI action") }
        let status = AXUIElementPerformAction(matching[0], kAXPressAction as CFString)
        guard status == .success else { stop("Expected alert AXPress failed: \(status.rawValue)") }
        let result: [String: Any] = ["pid": request.pid, "appId": request.appId,
            "method": "PID-scoped Accessibility AXPress on verified fatal-alert OK",
            "dialogTextVerified": true, "actionSucceeded": true,
            "elapsedMs": Int(Date().timeIntervalSince(started) * 1000)]
        let output = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(output)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    }
    Thread.sleep(forTimeInterval: 0.1)
} while Date().timeIntervalSince(started) < 5
stop("The exact fatal alert and unique OK were not found; confirm it manually")
