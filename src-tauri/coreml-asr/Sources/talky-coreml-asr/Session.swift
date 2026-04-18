import Foundation
import FluidAudio

actor Session {
    private var asrManager: AsrManager?

    // FluidAudio's Parakeet TDT expects a minimum clip length; Hex pads to
    // 1.5 s and we follow the same convention for short chunks coming from
    // Talky's VAD-bounded flushes.
    private static let minSamples = 24_000 // 1.5 s at 16 kHz

    func load(
        version: String,
        progressHandler: DownloadUtils.ProgressHandler? = nil
    ) async throws {
        let asrVersion: AsrModelVersion
        switch version.lowercased() {
        case "v2": asrVersion = .v2
        case "v3": asrVersion = .v3
        default: throw SessionError.unknownVersion(version)
        }
        let models = try await AsrModels.downloadAndLoad(
            version: asrVersion,
            progressHandler: progressHandler
        )
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)
        self.asrManager = manager
    }

    func transcribe(samples: [Float]) async throws -> String {
        guard let manager = asrManager else {
            throw SessionError.notLoaded
        }
        var input = samples
        if input.count < Self.minSamples {
            input.append(contentsOf: [Float](repeating: 0, count: Self.minSamples - input.count))
        }
        let result = try await manager.transcribe(input)
        return result.text
    }
}

enum SessionError: Error, CustomStringConvertible {
    case notLoaded
    case unknownVersion(String)

    var description: String {
        switch self {
        case .notLoaded: return "session_not_loaded"
        case .unknownVersion(let v): return "unknown_version: \(v)"
        }
    }
}
