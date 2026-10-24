import AVFoundation
import Capacitor
import Foundation
import Speech
import UIKit
#if canImport(Translation)
import Translation
#endif

/// Records the lecture and transcribes it on-device from the same microphone stream.
/// iPadOS 26+: SpeechAnalyzer (long-form model). Older: SFSpeechRecognizer on-device.
@objc(LectureAudioPlugin)
public class LectureAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LectureAudioPlugin"
    public let jsName = "LectureAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "translate", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var transcriber: LiveTranscriber?
    private var recording = false

    private var engineName: String {
        if #available(iOS 26.0, *) { return "speechanalyzer" }
        return "sfspeech"
    }

    // MARK: permissions

    @objc func prepare(_ call: CAPPluginCall) {
        Task {
            let mic = await AVAudioApplication.requestRecordPermission()
            let speech = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
            }
            call.resolve([
                "mic": mic,
                "speech": speech == .authorized,
                "engine": engineName,
            ])
        }
    }

    // MARK: recording + transcription

    @objc func start(_ call: CAPPluginCall) {
        if recording { return call.reject("이미 녹음 중이에요") }
        let vocabulary = call.getArray("vocabulary", String.self) ?? []

        Task {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
                try session.setActive(true)

                let input = engine.inputNode
                let format = input.outputFormat(forBus: 0)
                guard format.sampleRate > 0 else { throw PluginError("마이크를 찾을 수 없어요") }

                let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("recordings", isDirectory: true)
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent("rec-\(Int(Date().timeIntervalSince1970)).m4a")
                let settings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: format.sampleRate,
                    AVNumberOfChannelsKey: format.channelCount,
                    AVEncoderBitRateKey: 64000,
                ]
                let audioFile = try AVAudioFile(forWriting: url, settings: settings,
                                                commonFormat: format.commonFormat, interleaved: format.isInterleaved)

                let onResult: (String, Double, Double, Bool) -> Void = { [weak self] text, start, end, final in
                    self?.notifyListeners("transcript", data: ["text": text, "start": start, "end": end, "final": final])
                }
                let onError: (String) -> Void = { [weak self] msg in
                    self?.notifyListeners("error", data: ["message": msg])
                }

                let t: LiveTranscriber
                if #available(iOS 26.0, *) {
                    t = ModernTranscriber(onResult: onResult, onError: onError)
                } else {
                    t = LegacyTranscriber(sampleRate: format.sampleRate, onResult: onResult, onError: onError)
                }
                // Transcription failing (e.g. model still downloading) must not stop the recording.
                do {
                    try await t.start(vocabulary: vocabulary)
                } catch {
                    onError("자막을 시작하지 못했어요: \(error.localizedDescription)")
                }

                input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                    guard let self else { return }
                    try? self.file?.write(from: buffer)
                    self.transcriber?.append(buffer)
                }
                self.file = audioFile
                self.fileURL = url
                self.transcriber = t
                engine.prepare()
                try engine.start()
                recording = true
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true } // keep screen on in class
                call.resolve(["engine": engineName])
            } catch {
                engine.inputNode.removeTap(onBus: 0)
                call.reject("녹음을 시작할 수 없어요: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard recording, let url = fileURL else { return call.reject("녹음 중이 아니에요") }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        recording = false
        let t = transcriber
        transcriber = nil
        file = nil // closing the file finalises the m4a
        fileURL = nil
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
        Task {
            await t?.stop()
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            call.resolve(["uri": url.absoluteString, "path": url.path])
        }
    }

    // MARK: translation

    private var translator: AnyObject?

    @objc func translate(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else { return call.reject("text required") }
        #if canImport(Translation)
        if #available(iOS 26.0, *) {
            Task { @MainActor in
                do {
                    let session: TranslationSession
                    if let s = translator as? TranslationSession {
                        session = s
                    } else {
                        session = TranslationSession(installedSource: Locale.Language(identifier: "en"),
                                                     target: Locale.Language(identifier: "ko"))
                        translator = session
                    }
                    let response = try await session.translate(text)
                    call.resolve(["text": response.targetText])
                } catch {
                    translator = nil
                    call.reject("번역 실패 — 설정 > 앱 > 번역에서 영어·한국어를 다운로드했는지 확인하세요. (\(error.localizedDescription))")
                }
            }
            return
        }
        #endif
        call.unavailable("기기 내 번역은 iPadOS 26 이상에서 지원돼요")
    }
}

struct PluginError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

protocol LiveTranscriber: AnyObject {
    func start(vocabulary: [String]) async throws
    func append(_ buffer: AVAudioPCMBuffer)
    func stop() async
}

// MARK: - iPadOS 26+: SpeechAnalyzer

@available(iOS 26.0, *)
final class ModernTranscriber: LiveTranscriber {
    private let onResult: (String, Double, Double, Bool) -> Void
    private let onError: (String) -> Void
    private var analyzer: SpeechAnalyzer?
    private var inputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var targetFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var resultsTask: Task<Void, Never>?

    init(onResult: @escaping (String, Double, Double, Bool) -> Void, onError: @escaping (String) -> Void) {
        self.onResult = onResult
        self.onError = onError
    }

    func start(vocabulary: [String]) async throws {
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) ?? Locale(identifier: "en-US")
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults],
                                            attributeOptions: [.audioTimeRange])
        // First run downloads Apple's on-device English model.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])

        if !vocabulary.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings[.general] = vocabulary
            try? await analyzer.setContext(context)
        }

        let (stream, builder) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = builder

        resultsTask = Task { [onResult, onError] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    onResult(text, result.range.start.seconds, result.range.end.seconds, result.isFinal)
                }
            } catch {
                onError("자막 오류: \(error.localizedDescription)")
            }
        }
        try await analyzer.start(inputSequence: stream)
        self.analyzer = analyzer
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let inputBuilder, let target = targetFormat else { return }
        if buffer.format == target {
            inputBuilder.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, out.frameLength > 0 {
            inputBuilder.yield(AnalyzerInput(buffer: out))
        }
    }

    func stop() async {
        inputBuilder?.finish()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        _ = await resultsTask?.value
        analyzer = nil
        inputBuilder = nil
    }
}

// MARK: - Older iPadOS: SFSpeechRecognizer (on-device when available)

final class LegacyTranscriber: LiveTranscriber {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let sampleRate: Double
    private let onResult: (String, Double, Double, Bool) -> Void
    private let onError: (String) -> Void
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var tasks: [SFSpeechRecognitionTask] = []
    private var vocabulary: [String] = []
    private var framesSeen: AVAudioFramePosition = 0
    private var rotateTimer: Timer?
    private var stopping = false

    init(sampleRate: Double, onResult: @escaping (String, Double, Double, Bool) -> Void, onError: @escaping (String) -> Void) {
        self.sampleRate = sampleRate
        self.onResult = onResult
        self.onError = onError
    }

    func start(vocabulary: [String]) async throws {
        guard let recognizer, recognizer.isAvailable else { throw PluginError("이 기기에서 영어 음성인식을 쓸 수 없어요") }
        self.vocabulary = vocabulary
        startRequest()
        // A single request grows unboundedly; cut it into ~45s pieces so each becomes a final segment.
        await MainActor.run {
            rotateTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: true) { [weak self] _ in self?.rotate() }
        }
    }

    private func startRequest() {
        guard let recognizer else { return }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        req.contextualStrings = vocabulary
        if #available(iOS 16.0, *) { req.addsPunctuation = true }
        lock.lock()
        let base = Double(framesSeen) / sampleRate
        lock.unlock()

        let task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let t = result.bestTranscription
                let start = base + (t.segments.first?.timestamp ?? 0)
                let end = base + (t.segments.last.map { $0.timestamp + $0.duration } ?? 0)
                if !t.formattedString.isEmpty {
                    self.onResult(t.formattedString, start, end, result.isFinal)
                }
            }
            // Recognizer ended on its own (silence/timeout) — keep going with a fresh request.
            if (error != nil || result?.isFinal == true), self.isCurrent(req), !self.stopping {
                self.startRequest()
            }
        }
        lock.lock()
        request = req
        tasks.append(task)
        if tasks.count > 4 { tasks.removeFirst() }
        lock.unlock()
    }

    private func isCurrent(_ req: SFSpeechAudioBufferRecognitionRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return request === req
    }

    private func rotate() {
        lock.lock()
        let old = request
        lock.unlock()
        startRequest()
        old?.endAudio()
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        framesSeen += AVAudioFramePosition(buffer.frameLength)
        let req = request
        lock.unlock()
        req?.append(buffer)
    }

    private func takeRequest() -> SFSpeechAudioBufferRecognitionRequest? {
        lock.lock()
        defer { lock.unlock() }
        let req = request
        request = nil
        return req
    }

    func stop() async {
        stopping = true
        await MainActor.run { rotateTimer?.invalidate() }
        takeRequest()?.endAudio()
        try? await Task.sleep(nanoseconds: 1_500_000_000) // let the last final result arrive
    }
}
