// Test-controller only. Operates on existing processes; contains no app-launch API.
// libproc start time identifies direct-spawned processes without launchDate.
import AppKit
import ApplicationServices
import Darwin

struct ProcessIdentity: Codable, Equatable {
    let pid: Int32
    let ppid: UInt32
    let uid: UInt32
    let birth: String
    let name: String
}
struct DirectoryIdentity: Decodable {
    let path: String
    let device: String
    let inode: String
    let uid: UInt32
}
struct ActionResult: Encodable {
    let method: String
    let actionSucceeded: Bool
    var dialogTextVerified: Bool? = nil
}
struct Request: Decodable {
    let operation: String
    let pids: [Int32]?
    let expected: ProcessIdentity?
    let directories: [DirectoryIdentity]?
    let appRoot: String?
    let appId: String?
    let expectedTitle: String?
    let expectedMessage: String?
    let expectedExitCode: Int?
}
func stop(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(code)
}
func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(value) else { stop("Cannot encode process inspection") }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
}
func canonical(_ value: String) -> String? {
    guard let resolved = realpath(value, nil) else { return nil }
    defer { free(resolved) }; return String(cString: resolved)
}
func identity(_ pid: Int32) -> ProcessIdentity? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_status != 5 else { return nil } // SZOMB: an exited process cannot be acted on.
    var buffer = [CChar](repeating: 0, count: 4096) // libproc maximum path bytes
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    guard let name = canonical(String(cString: buffer)) else { return nil }
    return ProcessIdentity(pid: pid, ppid: info.pbi_ppid, uid: info.pbi_uid,
        birth: "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)", name: name)
}
func sameProcess(_ actual: ProcessIdentity?, _ expected: ProcessIdentity) -> Bool {
    guard let actual else { return false }
    // Parent can exit/reparent. Birth, owner and canonical executable may not change.
    return actual.pid == expected.pid && actual.uid == expected.uid
        && actual.birth == expected.birth && actual.name == expected.name
}
func validateDirectories(_ items: [DirectoryIdentity]?) -> Bool {
    guard let items, items.count >= 2 else { return false }
    for item in items {
        guard item.uid == getuid(), item.path.hasPrefix("/"),
              canonical(item.path) == item.path else { return false }
        var value = stat()
        guard lstat(item.path, &value) == 0, (value.st_mode & S_IFMT) == S_IFDIR,
              value.st_uid == item.uid, String(value.st_dev) == item.device,
              String(value.st_ino) == item.inode else { return false }
    }
    return true
}
guard CommandLine.arguments.count == 2 else { stop("Expected one controller request file") }
let request: Request
do { request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) }
catch { stop("Invalid controller request; no action") }
if request.operation == "inspect" {
    guard let pids = request.pids, pids.count <= 4096 else { stop("Invalid PID inspection") }
    emit(pids.compactMap(identity)); exit(0)
}
guard ["check", "quit", "confirm-fatal"].contains(request.operation),
      let expected = request.expected, expected.uid == getuid(),
      validateDirectories(request.directories),
      sameProcess(identity(expected.pid), expected) else {
    stop("Expected owned process or isolation directory is absent or changed; no action")
}
if request.operation == "check" { emit(expected); exit(0) }

let testExecutables = ["com.muhe.reverie.macos.test": "Reverie macOS Test",
                       "com.muhe.reverie.qt.local": "Reverie Scene"]
guard let appRoot = request.appRoot, let appId = request.appId,
      let executable = testExecutables[appId], canonical(appRoot) == appRoot,
      expected.name == appRoot + "/Contents/MacOS/" + executable else {
    stop("Request is outside the test application identity; no action")
}
func expectedApplication() -> NSRunningApplication? {
    guard validateDirectories(request.directories), sameProcess(identity(expected.pid), expected),
          let app = NSRunningApplication(processIdentifier: expected.pid), !app.isTerminated,
          app.bundleIdentifier == request.appId,
          app.bundleURL.flatMap({ canonical($0.path) }) == appRoot,
          app.executableURL.flatMap({ canonical($0.path) }) == expected.name else { return nil }
    return app
}
guard let app = expectedApplication() else { stop("Expected existing application changed; no action") }
if request.operation == "quit" {
    // This instance API never resolves by name/path and cannot launch an application.
    guard expectedApplication() != nil, app.terminate() else { stop("Existing application declined normal termination") }
    emit(ActionResult(method: "verified NSRunningApplication.terminate", actionSucceeded: true)); exit(0)
}
guard request.appId == "com.muhe.reverie.macos.test",
      request.expectedTitle == "Reverie 启动失败",
      request.expectedMessage == "安全初始化未完成，应用将退出。", request.expectedExitCode == 1 else {
    stop("Request is outside the fatal test-alert contract; no UI action")
}
// Do not request permissions or reopen/activate an app as a fallback.
guard AXIsProcessTrusted() else { stop("Existing Accessibility access unavailable; no UI action", code: 3) }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
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
    guard expectedApplication() != nil else { stop("Test process exited or changed before confirmation; no UI action") }
    let root = AXUIElementCreateApplication(expected.pid)
    let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
    var matching = [AXUIElement]()
    for window in windows {
        var texts = [String](), buttons = [AXUIElement]()
        inspect(window, depth: 0, texts: &texts, buttons: &buttons)
        if texts.contains(where: { $0.contains(request.expectedTitle!) })
            && texts.contains(where: { $0.contains(request.expectedMessage!) }) && buttons.count == 1 {
            matching.append(buttons[0])
        }
    }
    if matching.count == 1 {
        guard expectedApplication() != nil else { stop("Test process changed before AXPress; no UI action") }
        let status = AXUIElementPerformAction(matching[0], kAXPressAction as CFString)
        guard status == .success else { stop("Expected alert AXPress failed: \(status.rawValue)") }
        emit(ActionResult(method: "PID/birth-scoped AXPress on verified fatal-alert OK", actionSucceeded: true,
            dialogTextVerified: true)); exit(0)
    }
    Thread.sleep(forTimeInterval: 0.1)
} while Date().timeIntervalSince(started) < 5
stop("Exact fatal alert and unique OK not found; no UI action")
