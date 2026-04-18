import Foundation
import FluidAudio

/// Serializes every write to stdout. FluidAudio's progressHandler fires on an
/// unspecified queue; if the main loop writes a response frame while the
/// callback writes a progress frame, we'd interleave bytes and poison the
/// length-prefixed framing. Every writer goes through this queue.
final class OutputWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "talky.coreml-asr.stdout")
    private let handle: FileHandle

    init(_ handle: FileHandle) {
        self.handle = handle
    }

    func write(_ obj: [String: Any]) {
        queue.sync {
            guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
                stderrLine("failed to serialize response")
                return
            }
            var lenBE = UInt32(data.count).bigEndian
            let lenData = withUnsafeBytes(of: &lenBE) { Data($0) }
            do {
                try handle.write(contentsOf: lenData)
                try handle.write(contentsOf: data)
            } catch {
                stderrLine("stdout write error: \(error)")
            }
        }
    }
}

@main
struct Entry {
    static func main() async {
        let stdin = FileHandle.standardInput
        let writer = OutputWriter(FileHandle.standardOutput)
        let session = Session()

        stderrLine("talky-coreml-asr: ready")

        while true {
            guard let headerLenData = readExactly(4, from: stdin) else { return }
            let headerLen = headerLenData.withUnsafeBytes { ptr -> UInt32 in
                UInt32(bigEndian: ptr.loadUnaligned(as: UInt32.self))
            }
            if headerLen == 0 || headerLen > 1 << 20 {
                stderrLine("invalid header length \(headerLen)")
                return
            }
            guard let headerData = readExactly(Int(headerLen), from: stdin) else {
                stderrLine("eof while reading header")
                return
            }

            let header: [String: Any]
            do {
                guard let parsed = try JSONSerialization.jsonObject(with: headerData) as? [String: Any] else {
                    writer.write(["ok": false, "error": "header_not_object"])
                    continue
                }
                header = parsed
            } catch {
                writer.write(["ok": false, "error": "header_parse_failed: \(error)"])
                continue
            }

            guard let op = header["op"] as? String else {
                writer.write(["ok": false, "error": "missing_op"])
                continue
            }

            switch op {
            case "load":
                let version = (header["version"] as? String) ?? "v3"
                let wantsProgress = (header["progress"] as? Bool) ?? false
                var progressHandler: DownloadUtils.ProgressHandler? = nil
                if wantsProgress {
                    progressHandler = { [writer] progress in
                        var frame: [String: Any] = [
                            "ok": true,
                            "event": "progress",
                            "fraction": progress.fractionCompleted,
                        ]
                        switch progress.phase {
                        case .listing:
                            frame["phase"] = "listing"
                        case .downloading(let completed, let total):
                            frame["phase"] = "downloading"
                            frame["completed_files"] = completed
                            frame["total_files"] = total
                        case .compiling(let modelName):
                            frame["phase"] = "compiling"
                            frame["model_name"] = modelName
                        }
                        writer.write(frame)
                    }
                }
                do {
                    try await session.load(version: version, progressHandler: progressHandler)
                    writer.write(["ok": true, "event": "loaded"])
                } catch {
                    writer.write(["ok": false, "error": "load_failed: \(error)"])
                }

            case "transcribe":
                guard let len = header["len"] as? Int, len >= 0, len < 1 << 26 else {
                    writer.write(["ok": false, "error": "bad_len"])
                    continue
                }
                guard let bodyData = readExactly(len * 4, from: stdin) else {
                    stderrLine("eof while reading audio body")
                    return
                }
                var samples = [Float](repeating: 0, count: len)
                _ = samples.withUnsafeMutableBytes { dst in
                    bodyData.copyBytes(to: dst)
                }
                do {
                    let clock = ContinuousClock()
                    let start = clock.now
                    let text = try await session.transcribe(samples: samples)
                    let elapsed = clock.now - start
                    let inferMs = Double(elapsed.components.seconds) * 1000.0
                        + Double(elapsed.components.attoseconds) / 1e15
                    writer.write(["ok": true, "text": text, "infer_ms": inferMs])
                } catch {
                    writer.write(["ok": false, "error": "transcribe_failed: \(error)"])
                }

            case "shutdown":
                writer.write(["ok": true, "event": "shutdown"])
                return

            default:
                writer.write(["ok": false, "error": "unknown_op: \(op)"])
            }
        }
    }
}

private func readExactly(_ count: Int, from handle: FileHandle) -> Data? {
    var buf = Data()
    buf.reserveCapacity(count)
    while buf.count < count {
        let need = count - buf.count
        do {
            guard let chunk = try handle.read(upToCount: need), !chunk.isEmpty else {
                return nil
            }
            buf.append(chunk)
        } catch {
            stderrLine("stdin read error: \(error)")
            return nil
        }
    }
    return buf
}

private func stderrLine(_ s: String) {
    if let d = (s + "\n").data(using: .utf8) {
        try? FileHandle.standardError.write(contentsOf: d)
    }
}
