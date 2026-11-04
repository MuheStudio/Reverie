// Read-only, PID/birth/UID-scoped resource collection for disposable perf runs.
import Foundation
import Darwin

struct Identity: Codable, Equatable {
    let pid: Int32
    let ppid: UInt32
    let uid: UInt32
    let birth: String
    let name: String
}
struct Directory: Decodable { let path: String; let device: String; let inode: String; let uid: UInt32 }
struct Request: Decodable { let expected: [Identity]; let directories: [Directory] }
struct CpuTimebase: Encodable {
    let numerator: UInt32
    let denominator: UInt32
    let sourceUnit = "mach-absolute-time-ticks"
    let convertedUnit = "nanoseconds"
    let rounding = "integer-floor-per-counter"
}
func cpuNanoseconds(_ ticks: UInt64, _ timebase: CpuTimebase) -> UInt64 {
    let product = ticks.multipliedFullWidth(by: UInt64(timebase.numerator))
    let divisor = UInt64(timebase.denominator)
    guard divisor > 0, product.high < divisor else { stop("CPU timebase conversion overflow or invalid denominator") }
    return divisor.dividingFullWidth(product).quotient
}
struct Sample: Encodable {
    let identity: Identity
    let unixMs: Double
    let rawUserCpuTicks: UInt64
    let rawSystemCpuTicks: UInt64
    let cpuTimebase: CpuTimebase
    let userCpuNs: UInt64
    let systemCpuNs: UInt64
    let residentBytes: UInt64
    let physicalFootprintBytes: UInt64
    let threads: Int32
    let diskReadBytes: UInt64
    let diskWriteBytes: UInt64
}
struct Result: Encodable { let schema: String; let cpuTimebase: CpuTimebase; let samples: [Sample]; let absent: [Int32] }
func stop(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(2) }
func canonical(_ value: String) -> String? {
    guard let p = realpath(value, nil) else { return nil }; defer { free(p) }; return String(cString: p)
}
func identity(_ pid: Int32) -> Identity? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          info.pbi_status != 5 else { return nil }
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0, let name = canonical(String(cString: buffer)) else { return nil }
    return Identity(pid: pid, ppid: info.pbi_ppid, uid: info.pbi_uid,
        birth: "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)", name: name)
}
func same(_ actual: Identity?, _ expected: Identity) -> Bool {
    guard let actual else { return false }
    return actual.pid == expected.pid && actual.uid == expected.uid && actual.birth == expected.birth && actual.name == expected.name
}
guard CommandLine.arguments.count == 2 else { stop("Expected one resource request file") }
let request: Request
do {
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    guard data.count <= 65536 else { stop("Resource request too large") }
    request = try JSONDecoder().decode(Request.self, from: data)
} catch { stop("Invalid resource request") }
guard request.expected.count <= 32, request.directories.count >= 2 else { stop("Invalid owned resource scope") }
for item in request.directories {
    var value = stat()
    guard item.uid == getuid(), item.path.hasPrefix("/"), canonical(item.path) == item.path,
        lstat(item.path, &value) == 0, (value.st_mode & S_IFMT) == S_IFDIR,
        value.st_uid == item.uid, String(value.st_dev) == item.device, String(value.st_ino) == item.inode else { stop("Resource isolation directory changed") }
}
var machTimebase = mach_timebase_info_data_t()
let timebaseStatus = mach_timebase_info(&machTimebase)
guard timebaseStatus == KERN_SUCCESS, machTimebase.numer > 0, machTimebase.denom > 0 else {
    stop("CPU timebase is unavailable; no resource sample accepted")
}
let cpuTimebase = CpuTimebase(numerator: machTimebase.numer, denominator: machTimebase.denom)
var samples = [Sample](), absent = [Int32]()
for expected in request.expected {
    guard expected.uid == getuid() else { stop("Resource process has another owner") }
    guard let before = identity(expected.pid) else { absent.append(expected.pid); continue }
    guard same(before, expected) else { stop("Resource process identity changed") }
    var usage = rusage_info_v2()
    let status = withUnsafeMutablePointer(to: &usage) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(expected.pid, RUSAGE_INFO_V2, $0) }
    }
    var task = proc_taskinfo()
    let taskStatus = proc_pidinfo(expected.pid, PROC_PIDTASKINFO, 0, &task, Int32(MemoryLayout<proc_taskinfo>.size))
    // Observe identity immediately before and after the sample. Never accept
    // a recycled PID or infer successful inspection from an absent process.
    guard let after = identity(expected.pid) else { absent.append(expected.pid); continue }
    guard same(after, expected) else { stop("Resource process identity changed during sample") }
    guard status == 0, taskStatus == MemoryLayout<proc_taskinfo>.size else { stop("Owned resource inspection failed") }
    samples.append(Sample(identity: after, unixMs: Date().timeIntervalSince1970 * 1000,
        rawUserCpuTicks: usage.ri_user_time, rawSystemCpuTicks: usage.ri_system_time, cpuTimebase: cpuTimebase,
        userCpuNs: cpuNanoseconds(usage.ri_user_time, cpuTimebase), systemCpuNs: cpuNanoseconds(usage.ri_system_time, cpuTimebase),
        residentBytes: usage.ri_resident_size, physicalFootprintBytes: usage.ri_phys_footprint,
        threads: task.pti_threadnum, diskReadBytes: usage.ri_diskio_bytesread, diskWriteBytes: usage.ri_diskio_byteswritten))
}
let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
do { FileHandle.standardOutput.write(try encoder.encode(Result(schema: "reverie.qt.owned-resource-sample.v2", cpuTimebase: cpuTimebase, samples: samples, absent: absent))) }
catch { stop("Cannot encode owned resource samples") }
