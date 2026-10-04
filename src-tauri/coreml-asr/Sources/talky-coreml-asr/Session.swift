import Foundation
import FluidAudio

struct Transcript {
    let text: String
    /// Seconds from the start of the submitted audio to the first and last
    /// recognised token, when the model reports token timings.
    let speechSpan: (start: Double, end: Double)?
}

actor Session {
    private var asrManager: AsrManager?

    // FluidAudio's Parakeet TDT expects a minimum clip length; Hex pads to
    // 1.5 s and we follow the same convention for short chunks coming from
    // Talky's VAD-bounded flushes.
    private static let minSamples = 24_000 // 1.5 s at 16 kHz

    func load(
        version: String,
        progressHandler: ProgressHandler? = nil
    ) async throws {
        let asrVersion: AsrModelVersion
        switch version.lowercased() {
        case "v2": asrVersion = .v2
        case "v3": asrVersion = .v3
        case "ultra": asrVersion = .ultra
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

    func transcribe(samples: [Float]) async throws -> Transcript {
        guard let manager = asrManager else {
            throw SessionError.notLoaded
        }
        var input = samples
        if input.count < Self.minSamples {
            input.append(contentsOf: [Float](repeating: 0, count: Self.minSamples - input.count))
        }
        // Each chunk is an independent utterance: start from a fresh decoder.
        var state = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
        let result = try await manager.transcribe(input, decoderState: &state)
        var span: (start: Double, end: Double)? = nil
        if let timings = result.tokenTimings, let first = timings.first, let last = timings.last {
            span = (first.startTime, last.endTime)
        }
        return Transcript(text: result.text, speechSpan: span)
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
