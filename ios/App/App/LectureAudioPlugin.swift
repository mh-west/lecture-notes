import AVFoundation
import Capacitor
import CryptoKit
import Foundation
import Speech
import SwiftUI
import UIKit
import Vision
import whisper
import PencilKit
import UIKit.UIGestureRecognizerSubclass
import UniformTypeIdentifiers
#if canImport(Translation)
import Translation
#endif
#if canImport(FoundationModels)
import FoundationModels
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
        CAPPluginMethod(name: "pickAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transcribeFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "llmStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "llmTranslateLines", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "llmGenerate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signingInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInkPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearInkPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "renderInk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ocrImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "whisperStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "whisperDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "whisperDelete", returnType: CAPPluginReturnPromise),
    ]

    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var fileURL: URL?
    private var transcriber: LiveTranscriber?
    private var whisperLive: WhisperLive?
    private var whisperDownloader: WhisperDownloader?
    private var recording = false
    private var starting = false // a start() is still setting up; a second tap must not start twice

    // MARK: accurate captions (Whisper)

    @objc func whisperStatus(_ call: CAPPluginCall) {
        call.resolve(["installed": WhisperModel.installed, "downloading": whisperDownloader != nil, "size": WhisperModel.size])
    }

    /// Downloads the model (~570 MB), reporting `whisperProgress` { received, total }. Resolves when ready.
    @objc func whisperDownload(_ call: CAPPluginCall) {
        if WhisperModel.installed { return call.resolve() }
        guard whisperDownloader == nil else { return call.reject("이미 받는 중이에요") }
        let d = WhisperDownloader(
            progress: { [weak self] got, total in self?.notifyListeners("whisperProgress", data: ["received": got, "total": total]) },
            done: { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, self.whisperDownloader != nil else { return }
                    self.whisperDownloader = nil
                    if let error { call.reject("모델을 받지 못했어요: \(error.localizedDescription)") } else { call.resolve() }
                }
            })
        whisperDownloader = d
        d.start()
    }

    @objc func whisperDelete(_ call: CAPPluginCall) {
        try? FileManager.default.removeItem(at: WhisperModel.dir)
        call.resolve()
    }

    // MARK: text recognition (scanned PDFs)

    /// Reads the text in a page image (base64 PNG/JPEG) with Vision, Korean and English. Returns { text }.
    @objc func ocrImage(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"), let data = Data(base64Encoded: b64),
              let image = UIImage(data: data)?.cgImage else { return call.reject("image required") }
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["ko-KR", "en-US"]
            request.usesLanguageCorrection = true
            do {
                try VNImageRequestHandler(cgImage: image).perform([request])
                let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                call.resolve(["text": lines.joined(separator: "\n")])
            } catch {
                call.reject("글자를 읽지 못했어요: \(error.localizedDescription)")
            }
        }
    }

    // MARK: app signing

    /// When the development provisioning profile runs out; after that iOS won't open the app until it's reinstalled.
    @objc func signingInfo(_ call: CAPPluginCall) {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url),
              let text = String(data: raw, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>"),
              let plistData = String(text[start.lowerBound..<end.upperBound]).data(using: .isoLatin1),
              let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil) as? [String: Any],
              let expires = plist["ExpirationDate"] as? Date
        else { return call.resolve([:]) } // App Store / TestFlight builds have no such limit to show
        call.resolve(["expires": expires.timeIntervalSince1970 * 1000])
    }

    // MARK: Apple Pencil double-tap (the web view can't see it)

    private var pencilDelegate: PencilTapDelegate?
    private var inkLayer: InkLayer?
    private var pendingInk: ((InkLayer) -> Void)? // style sent before the layer existed

    /// Pen style for the native stroke preview; `enabled` is false for the eraser, lasso, etc.
    @objc func setInkPreview(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        let color = UIColor(hex: call.getString("color") ?? "#000000")
        let width = CGFloat(call.getDouble("width") ?? 2)
        let highlighter = call.getBool("highlighter") ?? false
        let alpha: CGFloat = 1 // PencilKit's marker is translucent by itself
        let area = call.getObject("area").map {
            CGRect(x: $0["x"] as? Double ?? 0, y: $0["y"] as? Double ?? 0, width: $0["w"] as? Double ?? 0, height: $0["h"] as? Double ?? 0)
        } ?? .zero
        DispatchQueue.main.async { [weak self] in
            let apply = { (p: InkLayer) in
                p.configure(enabled: enabled, color: color.withAlphaComponent(alpha), width: width, highlighter: highlighter, area: area)
            }
            if let p = self?.inkLayer { apply(p) } else { self?.pendingInk = apply }
        }
        call.resolve()
    }

    /// The page has drawn its own copy of the oldest finished stroke; remove it from the PencilKit layer.
    @objc func clearInkPreview(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.inkLayer?.committed() }
        call.resolve()
    }

    /// Renders saved PencilKit strokes as PNG images at a given zoom: items [{ id, data (base64 PKDrawing), k }],
    /// where k scales the stroke from the zoom it was written at. Returns { images: { id: base64 PNG } }.
    @objc func renderInk(_ call: CAPPluginCall) {
        let items = call.getArray("items", JSObject.self) ?? []
        let screen = call.getDouble("pixelRatio") ?? 2
        DispatchQueue.global(qos: .userInitiated).async {
            var images: [String: String] = [:]
            for item in items {
                guard let id = item["id"] as? String, let b64 = item["data"] as? String,
                      let data = Data(base64Encoded: b64), let drawing = try? PKDrawing(data: data) else { continue }
                let k = CGFloat(item["k"] as? Double ?? 1)
                let scaled = drawing.transformed(using: CGAffineTransform(scaleX: k, y: k))
                if let png = InkLayer.png(scaled, scale: screen) { images[id] = png }
            }
            call.resolve(["images": images])
        }
    }

    override public func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let view = self.bridge?.webView else { return }
            // UIScrollView holds every touch ~150 ms to see whether it becomes a scroll. The page scrolls
            // inside its own panes, so let touches through at once — otherwise the pencil starts late.
            view.scrollView.delaysContentTouches = false
            for g in view.scrollView.gestureRecognizers ?? [] { g.delaysTouchesBegan = false }
            // The web content view also carries drag-and-drop and Scribble, which wait to see whether a pencil
            // touch is a drag or handwriting before letting the page have it. Neither is used here.
            for content in view.scrollView.subviews {
                for i in content.interactions {
                    if let drag = i as? UIDragInteraction { drag.isEnabled = false }
                    if String(describing: type(of: i)).contains("Scribble") { content.removeInteraction(i) }
                }
                // WebKit's double-tap recognizers (zoom, word selection) would swallow the double-tap that
                // iPadOS uses on a window's top edge to resize it. The app uses neither.
                for g in content.gestureRecognizers ?? [] {
                    let name = String(describing: type(of: g))
                    if (g as? UITapGestureRecognizer)?.numberOfTapsRequired ?? 1 >= 2
                        || name.contains("MultiTap") || name.contains("TapAndAHalf") {
                        g.isEnabled = false
                    }
                }
            }
            // Touches over the web view reach even native code late, and the page's JavaScript later still.
            // A PencilKit layer over the pages takes the pencil directly; the page saves each finished stroke.
            let ink = InkLayer(over: view) { [weak self] event, data in self?.notifyListeners(event, data: data) }
            self.inkLayer = ink
            self.pendingInk?(ink)
            let delegate = PencilTapDelegate { [weak self] in self?.notifyListeners("pencilDoubleTap", data: [:]) }
            let interaction = UIPencilInteraction()
            interaction.delegate = delegate
            view.addInteraction(interaction)
            self.pencilDelegate = delegate
        }
    }

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
        if recording || starting { return call.reject("이미 녹음을 시작하고 있어요") }
        starting = true
        let vocabulary = call.getArray("vocabulary", String.self) ?? []
        let locale = Locale(identifier: call.getString("locale") ?? "en-US")

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

                // Prefer the iPadOS 26 long-form model; fall back to SFSpeechRecognizer
                // on older systems or when the model doesn't cover this language.
                var t: LiveTranscriber = LegacyTranscriber(locale: locale, sampleRate: format.sampleRate, onResult: onResult, onError: onError)
                var used = "sfspeech"
                if #available(iOS 26.0, *), let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
                    t = ModernTranscriber(locale: supported, onResult: onResult, onError: onError)
                    used = "speechanalyzer"
                }
                // Record first, answer the button, then let the speech model start up in the background:
                // it can take seconds (or download first), and the lecture must not wait for it. Captions
                // just begin a moment later.
                self.file = audioFile
                self.fileURL = url
                self.transcriber = t
                // Accurate captions: Whisper re-transcribes every ~30 s and replaces the live lines.
                let useWhisper = (call.getBool("whisper") ?? false) && WhisperModel.installed
                self.whisperLive = useWhisper ? WhisperLive(
                    language: locale.language.languageCode?.identifier ?? "en",
                    onChunk: { [weak self] start, end, lines in
                        self?.notifyListeners("whisperChunk", data: ["start": start, "end": end, "lines": lines])
                    },
                    onError: onError) : nil
                input.removeTap(onBus: 0) // a tap left behind would make installTap throw
                input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                    guard let self else { return }
                    try? self.file?.write(from: buffer) // the recording keeps the original sound
                    self.whisperLive?.append(buffer)
                    self.transcriber?.append(buffer)
                }
                engine.prepare()
                try engine.start()
                recording = true
                starting = false
                RecordingMarker.set(true) // tells scripts/ipad-install.sh not to reinstall mid-lecture
                await MainActor.run { UIApplication.shared.isIdleTimerDisabled = true } // keep screen on in class
                call.resolve(["engine": used, "locale": locale.identifier, "whisper": useWhisper])
                // Transcription failing (e.g. model still downloading) must not stop the recording.
                do {
                    try await t.start(vocabulary: vocabulary)
                } catch {
                    onError("자막을 시작하지 못했어요: \(error.localizedDescription)")
                }
            } catch {
                engine.inputNode.removeTap(onBus: 0)
                starting = false
                call.reject("녹음을 시작할 수 없어요: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard recording, let url = fileURL else { return call.reject("녹음 중이 아니에요") }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        recording = false
        RecordingMarker.set(false)
        let t = transcriber
        transcriber = nil
        let w = whisperLive
        whisperLive = nil
        w?.finish { [weak self] in self?.notifyListeners("whisperDone", data: [:]) }
        file = nil // closing the file finalises the m4a
        fileURL = nil
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        // The m4a is complete once the file is closed: answer now. Letting the speech model finish its
        // last captions can take a long while (or never end if it was still starting up).
        call.resolve(["uri": url.absoluteString, "path": url.path])
        Task { await t?.stop() }
    }

    // MARK: importing an existing recording (e.g. exported from Goodnotes)

    private var picker: AudioPickerDelegate?

    @objc func pickAudio(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [self] in
            let vc = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
            let delegate = AudioPickerDelegate { [weak self] url in
                self?.picker = nil
                guard let url else { return call.reject("취소했어요", "CANCELED") }
                Task {
                    do {
                        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                            .appendingPathComponent("recordings", isDirectory: true)
                        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                        let dest = dir.appendingPathComponent("import-\(Int(Date().timeIntervalSince1970))-\(url.lastPathComponent)")
                        try FileManager.default.moveItem(at: url, to: dest)
                        let duration = try await AVURLAsset(url: dest).load(.duration).seconds
                        let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
                        let created = (attrs?[.creationDate] as? Date) ?? Date()
                        call.resolve([
                            "uri": dest.absoluteString, "path": dest.path, "name": url.lastPathComponent,
                            "duration": duration, "createdAt": created.timeIntervalSince1970 * 1000,
                        ])
                    } catch {
                        call.reject("파일을 가져오지 못했어요: \(error.localizedDescription)")
                    }
                }
            }
            picker = delegate
            vc.delegate = delegate
            bridge?.viewController?.present(vc, animated: true)
        }
    }

    /// Transcribes a whole audio file. Emits `fileProgress` while running and resolves with the final segments.
    @objc func transcribeFile(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else { return call.reject("path required") }
        let vocabulary = call.getArray("vocabulary", String.self) ?? []
        let locale = Locale(identifier: call.getString("locale") ?? "en-US")
        if call.getBool("whisper") == true, WhisperModel.installed {
            let language = locale.language.languageCode?.identifier ?? "en"
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true } // the GPU stops if the iPad locks
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                do {
                    let segments = try WhisperFile.run(url: URL(fileURLWithPath: path), language: language) { t in
                        self?.notifyListeners("fileProgress", data: ["seconds": t])
                    }
                    call.resolve(["segments": segments, "engine": "whisper"])
                } catch {
                    call.reject("자막을 만들지 못했어요: \(error.localizedDescription)")
                }
                DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
            }
            return
        }
        guard #available(iOS 26.0, *) else {
            return call.unavailable("녹음 파일 자막은 iPadOS 26 이상에서 지원돼요")
        }
        Task {
            do {
                let segments = try await FileTranscriber.run(url: URL(fileURLWithPath: path), locale: locale, vocabulary: vocabulary) { [weak self] t in
                    self?.notifyListeners("fileProgress", data: ["seconds": t])
                }
                call.resolve(["segments": segments])
            } catch {
                call.reject("자막을 만들지 못했어요: \(error.localizedDescription)")
            }
        }
    }

    // MARK: on-device language model (Apple Intelligence)

    @objc func llmStatus(_ call: CAPPluginCall) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return call.resolve(["available": true])
            case .unavailable(.deviceNotEligible):
                return call.resolve(["available": false, "reason": "이 기기는 Apple Intelligence를 지원하지 않아요"])
            case .unavailable(.appleIntelligenceNotEnabled):
                return call.resolve(["available": false, "reason": "설정 > Apple Intelligence에서 켜 주세요"])
            case .unavailable(.modelNotReady):
                return call.resolve(["available": false, "reason": "기기 내 AI 모델을 내려받는 중이에요. 잠시 후 다시 시도하세요"])
            case .unavailable:
                return call.resolve(["available": false, "reason": "기기 내 AI를 지금 쓸 수 없어요"])
            }
        }
        #endif
        call.resolve(["available": false, "reason": "기기 내 AI는 iPadOS 26 이상에서 지원돼요"])
    }

    /// Translates numbered caption lines; returns one Korean string per input line (empty = filler only).
    @objc func llmTranslateLines(_ call: CAPPluginCall) {
        let instructions = call.getString("instructions") ?? ""
        let prompt = call.getString("prompt") ?? ""
        let count = call.getInt("count") ?? 0
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: instructions)
                    let r = try await session.respond(to: prompt, generating: TranslatedLines.self,
                                                      options: GenerationOptions(temperature: 0.2))
                    var out = Array(repeating: "", count: count)
                    for l in r.content.lines where l.number >= 1 && l.number <= count { out[l.number - 1] = l.korean }
                    call.resolve(["lines": out])
                } catch {
                    call.reject("기기 내 AI 번역 실패: \(error.localizedDescription)")
                }
            }
            return
        }
        #endif
        call.unavailable("기기 내 AI는 iPadOS 26 이상에서 지원돼요")
    }

    @objc func llmGenerate(_ call: CAPPluginCall) {
        let instructions = call.getString("instructions") ?? ""
        let prompt = call.getString("prompt") ?? ""
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            Task {
                do {
                    let session = LanguageModelSession(instructions: instructions)
                    let r = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.3))
                    call.resolve(["text": r.content])
                } catch {
                    call.reject("기기 내 AI 실패: \(error.localizedDescription)")
                }
            }
            return
        }
        #endif
        call.unavailable("기기 내 AI는 iPadOS 26 이상에서 지원돼요")
    }

    // MARK: translation

    private var translator: AnyObject? // TranslationWorker, created on first use

    @objc func translate(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else { return call.reject("text required") }
        #if canImport(Translation)
        if #available(iOS 26.0, *) {
            Task { @MainActor in
                let worker: TranslationWorker
                if let w = translator as? TranslationWorker {
                    worker = w
                } else {
                    guard let vc = bridge?.viewController else { return call.reject("화면이 아직 준비되지 않았어요") }
                    worker = TranslationWorker(attachedTo: vc)
                    translator = worker
                }
                do {
                    call.resolve(["text": try await worker.translate(text)])
                } catch {
                    // A cancelled session (e.g. the download sheet was dismissed) can't be reused; start fresh next time.
                    worker.detach()
                    translator = nil
                    call.reject("번역 실패 — 영어·한국어 번역 언어를 내려받았는지 확인하세요. (\(error.localizedDescription))")
                }
            }
            return
        }
        #endif
        call.unavailable("기기 내 번역은 iPadOS 26 이상에서 지원돼요")
    }
}

/// Owns a long-lived `TranslationSession` the way Apple intends: through SwiftUI's `.translationTask`,
/// hosted in an invisible 1×1 view. The system shows its own language-download sheet when needed.
@available(iOS 26.0, *)
@MainActor
final class TranslationWorker {
    private struct Job {
        let text: String
        let done: CheckedContinuation<String, Error>
    }
    private let jobs: AsyncStream<Job>.Continuation
    private let host: UIViewController

    init(attachedTo vc: UIViewController) {
        let (stream, input) = AsyncStream<Job>.makeStream()
        jobs = input
        let config = TranslationSession.Configuration(source: Locale.Language(identifier: "en"),
                                                      target: Locale.Language(identifier: "ko"))
        let view = Color.clear.frame(width: 1, height: 1).translationTask(config) { session in
            for await job in stream {
                do {
                    job.done.resume(returning: try await session.translate(job.text).targetText)
                } catch {
                    job.done.resume(throwing: error)
                }
            }
        }
        let host = UIHostingController(rootView: view)
        self.host = host
        host.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        vc.addChild(host)
        vc.view.addSubview(host.view)
        host.didMove(toParent: vc)
    }

    func detach() {
        jobs.finish()
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
    }

    func translate(_ text: String) async throws -> String {
        try await withCheckedThrowingContinuation { jobs.yield(Job(text: text, done: $0)) }
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable struct TranslatedLine {
    @Guide(description: "The caption line number, copied from the input") var number: Int
    @Guide(description: "Natural Korean translation of that line with fillers removed; empty if the line is only filler") var korean: String
}

@available(iOS 26.0, *)
@Generable struct TranslatedLines {
    var lines: [TranslatedLine]
}
#endif

/// A transparent PencilKit canvas laid over the page area while the pen or highlighter is selected.
/// The pencil draws on it with PencilKit's own low latency. When a stroke is finished it is sent to the page
/// (points for erasing/ordering, the PKDrawing data, and a PNG of exactly what was drawn); the page then
/// draws that image and acknowledges, and the stroke is removed from this layer. Finger gestures landing on
/// the layer (scroll, pinch, tap) are forwarded to the page, which scrolls itself.
final class InkLayer: NSObject, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
    private let container = UIView()
    private let canvas = PKCanvasView()
    private weak var host: UIView?
    private let emit: (String, [String: Any]) -> Void
    private var area = CGRect.zero
    private var known = 0 // strokes on the canvas we have already reported
    private var pendingRemovals = 0
    private var pencilDown = false
    private var pinching = false
    private var panSawPinch = false // the current one-finger pan turned into a pinch at some point
    private var restWork: DispatchWorkItem?
    private var highlighter = false
    private var inkColor = UIColor.black
    private var inkWidth: CGFloat = 2
    // Hold to straighten: the pencil staying put for a while at the end of a stroke makes it a straight line.
    private static let holdSeconds = 2.0
    private static let holdSlop: CGFloat = 5 // points of hand tremor that still count as staying put
    private var strokeStart: CGPoint?
    private var holdAnchor = CGPoint.zero
    private var holdWork: DispatchWorkItem?
    private var straighten = false
    private let holdPreview = CAShapeLayer()
    private let pan = UIPanGestureRecognizer()
    private let pinch = UIPinchGestureRecognizer()
    private let tap = UITapGestureRecognizer()

    init(over host: UIView, emit: @escaping (String, [String: Any]) -> Void) {
        self.host = host
        self.emit = emit
        super.init()
        container.backgroundColor = .clear
        container.isHidden = true
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.drawingPolicy = .pencilOnly
        canvas.isScrollEnabled = false
        canvas.delegate = self
        canvas.frame = container.bounds
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(canvas)
        (host.superview ?? host).addSubview(container)

        let fingers = [UITouch.TouchType.direct.rawValue as NSNumber]
        pan.addTarget(self, action: #selector(onPan))
        pan.maximumNumberOfTouches = 1
        pinch.addTarget(self, action: #selector(onPinch))
        tap.addTarget(self, action: #selector(onTap))
        for g in [pan, pinch, tap] as [UIGestureRecognizer] {
            g.allowedTouchTypes = fingers
            g.delegate = self
            container.addGestureRecognizer(g)
        }
        holdPreview.fillColor = nil
        holdPreview.lineCap = .round
        container.layer.addSublayer(holdPreview)
        let pencil = PencilState(moved: { [weak self] p in self?.pencilMoved(to: p) }) { [weak self] down in
            guard let self else { return }
            self.pencilDown = down
            self.restWork?.cancel()
            self.holdWork?.cancel()
            self.holdPreview.path = nil
            if down {
                self.strokeStart = nil
                self.straighten = false
            }
            guard !down else { return }
            // Tidy up only once the pencil has rested, so a stroke started right after is never disturbed.
            let work = DispatchWorkItem { [weak self] in self?.applyRemovals() }
            self.restWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
        }
        canvas.addGestureRecognizer(pencil)
    }

    func configure(enabled: Bool, color: UIColor, width: CGFloat, highlighter: Bool, area: CGRect) {
        self.area = area
        self.highlighter = highlighter
        container.isHidden = !enabled
        if let host { container.frame = area.offsetBy(dx: host.frame.minX, dy: host.frame.minY) }
        inkColor = color
        inkWidth = width
        // Monoline: the same width whatever the pressure or speed, like a ballpoint.
        canvas.tool = PKInkingTool(highlighter ? .marker : .monoline, color: color, width: highlighter ? width * 4 : width)
    }

    // MARK: hold to straighten

    private func pencilMoved(to p: CGPoint) {
        guard strokeStart != nil else {
            strokeStart = p
            holdAnchor = p
            armHold()
            return
        }
        guard hypot(p.x - holdAnchor.x, p.y - holdAnchor.y) > Self.holdSlop else { return }
        holdAnchor = p
        straighten = false
        holdPreview.path = nil
        armHold()
    }

    private func armHold() {
        holdWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.holdReached() }
        holdWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdSeconds, execute: work)
    }

    /// Long enough to be a line (not a dot being pressed): show what it will become when the pencil lifts.
    private func holdReached() {
        guard pencilDown, let start = strokeStart, hypot(holdAnchor.x - start.x, holdAnchor.y - start.y) >= 20 else { return }
        straighten = true
        let path = UIBezierPath()
        path.move(to: start)
        path.addLine(to: holdAnchor)
        holdPreview.strokeColor = inkColor.withAlphaComponent(highlighter ? 0.4 : 1).cgColor
        holdPreview.lineWidth = highlighter ? inkWidth * 4 : inkWidth
        holdPreview.path = path.cgPath
    }

    /// A stored stroke's thickness comes from its points' sizes alone (thickness = 2 × size - 4).
    private static func pointSize(thickness: CGFloat) -> CGFloat { thickness / 2 + 2 }

    /// `stroke` as a straight line from its first to its last point.
    private static func straightened(_ stroke: PKStroke) -> PKStroke? {
        let pts = Array(stroke.path)
        guard let a = pts.first, let b = pts.last else { return nil }
        let middle = pts[pts.count / 2]
        let n = max(2, Int(hypot(b.location.x - a.location.x, b.location.y - a.location.y) / 8))
        let line = (0...n).map { i -> PKStrokePoint in
            let t = CGFloat(i) / CGFloat(n)
            return PKStrokePoint(location: CGPoint(x: a.location.x + (b.location.x - a.location.x) * t, y: a.location.y + (b.location.y - a.location.y) * t),
                                 timeOffset: b.timeOffset * Double(t), size: middle.size, opacity: middle.opacity,
                                 force: middle.force, azimuth: middle.azimuth, altitude: middle.altitude)
        }
        return PKStroke(ink: stroke.ink, path: PKStrokePath(controlPoints: line, creationDate: stroke.path.creationDate),
                        transform: stroke.transform, mask: stroke.mask)
    }

    /// The monoline tool stops at width 4. Zoomed in, the width asked for is more: the finished stroke gets it.
    private static func resized(_ stroke: PKStroke, thickness: CGFloat) -> PKStroke {
        let s = pointSize(thickness: thickness)
        let pts = stroke.path.map { p in
            PKStrokePoint(location: p.location, timeOffset: p.timeOffset, size: CGSize(width: s, height: s), opacity: p.opacity,
                          force: p.force, azimuth: p.azimuth, altitude: p.altitude)
        }
        return PKStroke(ink: stroke.ink, path: PKStrokePath(controlPoints: pts, creationDate: stroke.path.creationDate),
                        transform: stroke.transform, mask: stroke.mask)
    }

    // MARK: strokes

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let strokes = canvasView.drawing.strokes
        defer { known = strokes.count }
        guard strokes.count > known, var stroke = strokes.last else { return }
        print("[ink] tool width \(inkWidth) point size \(stroke.path.first?.size.width ?? 0)")
        var changed = false
        if straighten, let line = Self.straightened(stroke) {
            stroke = line
            changed = true
        }
        straighten = false
        if !highlighter, inkWidth > 4 {
            stroke = Self.resized(stroke, thickness: inkWidth)
            changed = true
        }
        if changed {
            known = strokes.count // this change of the drawing is not a new stroke
            canvasView.drawing = PKDrawing(strokes: strokes.dropLast() + [stroke])
        }
        // Report in web-view coordinates: the layer sits at `area` inside the web view.
        let dx = area.minX, dy = area.minY
        var points: [[String: Double]] = []
        for p in stroke.path {
            points.append(["x": Double(p.location.x + dx), "y": Double(p.location.y + dy), "p": Double(min(1, max(0.05, p.force)))])
        }
        let b = stroke.renderBounds
        let one = PKDrawing(strokes: [stroke])
        emit("inkStroke", [
            "points": points,
            "startedAt": stroke.path.creationDate.timeIntervalSince1970 * 1000,
            "data": one.dataRepresentation().base64EncodedString(),
            "png": InkLayer.png(one, scale: canvas.window?.screen.scale ?? 2) ?? "",
            "bounds": ["x": Double(b.minX + dx), "y": Double(b.minY + dy), "w": Double(b.width), "h": Double(b.height)],
        ])
    }

    /// The page drew the oldest reported stroke. Strokes are only removed between strokes, never mid-stroke.
    func committed() {
        pendingRemovals += 1
        // Translucent highlighter copies would darken while overlapping, so those go right away.
        if highlighter || restWork == nil || restWork!.isCancelled { applyRemovals() } // otherwise the rest timer will
    }

    private func applyRemovals() {
        restWork = nil
        guard !pencilDown, pendingRemovals > 0 else { return }
        let strokes = canvas.drawing.strokes
        let n = min(pendingRemovals, strokes.count)
        pendingRemovals = 0
        known = strokes.count - n
        canvas.drawing = PKDrawing(strokes: Array(strokes.dropFirst(n)))
    }

    static func png(_ drawing: PKDrawing, scale: CGFloat) -> String? {
        let b = drawing.bounds
        guard b.width > 0, b.height > 0 else { return nil }
        var img: UIImage?
        // PKDrawing.image must run with a light trait collection or ink colors may invert in dark mode.
        UITraitCollection(userInterfaceStyle: .light).performAsCurrent {
            img = drawing.image(from: b, scale: scale)
        }
        return img?.pngData()?.base64EncodedString()
    }

    // MARK: fingers → page

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        (g === pan && other === pinch) || (g === pinch && other === pan)
    }

    private func webPoint(_ g: UIGestureRecognizer) -> [String: Double] {
        let p = g.location(in: container)
        return ["x": Double(p.x + area.minX), "y": Double(p.y + area.minY)]
    }

    private func phase(_ s: UIGestureRecognizer.State) -> String {
        switch s {
        case .began: return "began"
        case .changed: return "changed"
        default: return "ended"
        }
    }

    @objc private func onPan(_ g: UIPanGestureRecognizer) {
        if g.state == .began { panSawPinch = false }
        // A second finger makes it a pinch: this pan must neither scroll nor fling afterwards.
        if pinching || g.numberOfTouches > 1 { panSawPinch = true }
        if pencilDown || panSawPinch { return }
        let t = g.translation(in: container), v = g.velocity(in: container)
        emit("fingerPan", ["state": phase(g.state), "dx": Double(t.x), "dy": Double(t.y), "vx": Double(v.x), "vy": Double(v.y)])
    }

    @objc private func onPinch(_ g: UIPinchGestureRecognizer) {
        if pencilDown { return }
        pinching = g.state == .began || g.state == .changed
        if pinching { panSawPinch = true }
        var data: [String: Any] = webPoint(g)
        data["state"] = phase(g.state)
        data["scale"] = Double(g.scale)
        emit("fingerPinch", data)
    }

    @objc private func onTap(_ g: UITapGestureRecognizer) {
        emit("fingerTap", webPoint(g))
    }
}

/// Only reports whether the pencil is on the canvas; never takes the touches away from PencilKit.
final class PencilState: UIGestureRecognizer {
    private let changed: (Bool) -> Void
    private let moved: (CGPoint) -> Void
    init(moved: @escaping (CGPoint) -> Void, changed: @escaping (Bool) -> Void) {
        self.moved = moved
        self.changed = changed
        super.init(target: nil, action: nil)
        allowedTouchTypes = [UITouch.TouchType.pencil.rawValue as NSNumber]
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }
    override func canPrevent(_ g: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by g: UIGestureRecognizer) -> Bool { false }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        changed(true)
        if let p = touches.first?.location(in: view) { moved(p) }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if let p = touches.first?.location(in: view) { moved(p) }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { changed(false); state = .failed }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { changed(false); state = .failed }
}

extension UIColor {
    convenience init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&v)
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}

/// Documents/.recording-active exists (holding the start time) while a lecture is being recorded.
/// The Mac's auto-reinstall script reads it so it never closes the app in the middle of a lecture.
enum RecordingMarker {
    static func set(_ on: Bool) {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(".recording-active")
        if on { try? String(Int(Date().timeIntervalSince1970)).write(to: url, atomically: true, encoding: .utf8) }
        else { try? FileManager.default.removeItem(at: url) }
    }
}

final class PencilTapDelegate: NSObject, UIPencilInteractionDelegate {
    private let onTap: () -> Void
    init(onTap: @escaping () -> Void) { self.onTap = onTap }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        onTap()
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        onTap()
    }
}

final class AudioPickerDelegate: NSObject, UIDocumentPickerDelegate {
    private let done: (URL?) -> Void
    init(done: @escaping (URL?) -> Void) { self.done = done }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(urls.first) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done(nil) }
}

@available(iOS 26.0, *)
enum FileTranscriber {
    static func run(url: URL, locale wanted: Locale, vocabulary: [String], progress: @escaping (Double) -> Void) async throws -> [[String: Any]] {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else {
            throw PluginError("이 기기에서 \(wanted.identifier) 음성 인식을 쓸 수 없어요")
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                            attributeOptions: [.audioTimeRange])
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
        let file = try AVAudioFile(forReading: url)
        let context = AnalysisContext()
        if !vocabulary.isEmpty { context.contextualStrings[.general] = vocabulary }
        let collect = Task {
            var out: [[String: Any]] = []
            for try await result in transcriber.results {
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                let end = result.range.end.seconds
                out.append(["text": text, "start": result.range.start.seconds, "end": end])
                progress(end)
            }
            return out
        }
        let analyzer = try await SpeechAnalyzer(inputAudioFile: file, modules: [transcriber],
                                                analysisContext: context, finishAfterFile: true)
        _ = analyzer
        return try await collect.value
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
    private let lock = NSLock()
    private var dropped: Double = 0

    private let locale: Locale

    init(locale: Locale, onResult: @escaping (String, Double, Double, Bool) -> Void, onError: @escaping (String) -> Void) {
        self.locale = locale
        self.onResult = onResult
        self.onError = onError
    }

    func start(vocabulary: [String]) async throws {
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

        resultsTask = Task { [onResult, onError, weak self] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    let offset = self?.droppedSeconds ?? 0
                    onResult(text, result.range.start.seconds + offset, result.range.end.seconds + offset, result.isFinal)
                }
            } catch {
                onError("자막 오류: \(error.localizedDescription)")
            }
        }
        try await analyzer.start(inputSequence: stream)
        self.analyzer = analyzer
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let inputBuilder, let target = targetFormat else {
            // Audio before the model is ready isn't analysed; its length shifts the result times back
            // onto the recording's clock.
            lock.lock()
            dropped += Double(buffer.frameLength) / buffer.format.sampleRate
            lock.unlock()
            return
        }
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

    private var droppedSeconds: Double {
        lock.lock()
        defer { lock.unlock() }
        return dropped
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
    private let recognizer: SFSpeechRecognizer?
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

    init(locale: Locale, sampleRate: Double, onResult: @escaping (String, Double, Double, Bool) -> Void, onError: @escaping (String) -> Void) {
        recognizer = SFSpeechRecognizer(locale: locale)
        self.sampleRate = sampleRate
        self.onResult = onResult
        self.onError = onError
    }

    func start(vocabulary: [String]) async throws {
        guard let recognizer, recognizer.isAvailable else { throw PluginError("이 기기에서 이 언어의 음성인식을 쓸 수 없어요") }
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

// MARK: - Whisper (accurate captions)

/// The Whisper model for accurate captions: downloaded once into Application Support (not backed up).
enum WhisperModel {
    static let name = "ggml-large-v3-turbo-q5_0.bin"
    static let url = URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin")!
    static let sha256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
    static let size: Int64 = 574_041_195
    static var dir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("whisper", isDirectory: true)
    }
    static var path: URL { dir.appendingPathComponent(name) }
    static var installed: Bool {
        ((try? FileManager.default.attributesOfItem(atPath: path.path))?[.size] as? NSNumber)?.int64Value == size
    }

    static func sha256(of url: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        var hasher = SHA256()
        while let data = try h.read(upToCount: 8 << 20), !data.isEmpty { hasher.update(data: data) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Downloads the model with progress, checks it against its published SHA-256, then moves it in place.
final class WhisperDownloader: NSObject, URLSessionDownloadDelegate {
    private let progress: (Int64, Int64) -> Void
    private let done: (Error?) -> Void
    private var session: URLSession?
    private var lastReport = Date.distantPast

    init(progress: @escaping (Int64, Int64) -> Void, done: @escaping (Error?) -> Void) {
        self.progress = progress
        self.done = done
    }

    func start() {
        let s = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        session = s
        s.downloadTask(with: WhisperModel.url).resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard Date().timeIntervalSince(lastReport) > 0.5 else { return }
        lastReport = Date()
        progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : WhisperModel.size)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: WhisperModel.dir, withIntermediateDirectories: true)
            // The temporary file disappears when this returns: move it first, then check it.
            let tmp = WhisperModel.dir.appendingPathComponent("download.tmp")
            try? fm.removeItem(at: tmp)
            try fm.moveItem(at: location, to: tmp)
            guard try WhisperModel.sha256(of: tmp) == WhisperModel.sha256 else {
                try? fm.removeItem(at: tmp)
                throw PluginError("받은 모델 파일이 올바르지 않아요. 다시 받아 주세요")
            }
            try? fm.removeItem(at: WhisperModel.path)
            try fm.moveItem(at: tmp, to: WhisperModel.path)
            var dirURL = WhisperModel.dir
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            try? dirURL.setResourceValues(rv)
            done(nil)
        } catch {
            done(error)
        }
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { done(error) }
        session.finishTasksAndInvalidate()
    }
}

/// One loaded Whisper model (Metal on the GPU).
final class WhisperContext {
    private let ctx: OpaquePointer

    init?(path: String) {
        var p = whisper_context_default_params()
        p.use_gpu = true
        p.flash_attn = true
        guard let c = whisper_init_from_file_with_params(path, p) else { return nil }
        ctx = c
    }

    deinit { whisper_free(ctx) }

    /// Segments (start, end in seconds within `samples`, text) of 16 kHz mono audio.
    func transcribe(_ samples: [Float], language: String, prompt: String) -> [(Double, Double, String)]? {
        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.print_progress = false
        params.print_realtime = false
        params.print_special = false
        params.print_timestamps = false
        params.n_threads = 4
        params.no_context = true
        params.suppress_nst = true
        let lang = strdup(language)
        // The previous chunk's words as context (not a term list: hints made Whisper repeat itself).
        let pr = prompt.isEmpty ? nil : strdup(prompt)
        defer {
            free(lang)
            free(pr)
        }
        params.language = UnsafePointer(lang)
        params.initial_prompt = UnsafePointer(pr)
        let ok = samples.withUnsafeBufferPointer { whisper_full(ctx, params, $0.baseAddress, Int32($0.count)) }
        guard ok == 0 else { return nil }
        return (0..<whisper_full_n_segments(ctx)).compactMap { i in
            guard let t = whisper_full_get_segment_text(ctx, i) else { return nil }
            let text = String(cString: t).trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { return nil }
            // Whisper's own estimate that this stretch is not speech: what it writes there is invented.
            if whisper_full_get_segment_no_speech_prob(ctx, i) > 0.6 { return nil }
            return (Double(whisper_full_get_segment_t0(ctx, i)) / 100, Double(whisper_full_get_segment_t1(ctx, i)) / 100, text)
        }
    }
}

/// Whisper over a whole recorded file, one chunk at a time so memory stays flat on a long lecture.
enum WhisperFile {
    static func run(url: URL, language: String, progress: @escaping (Double) -> Void) throws -> [[String: Any]] {
        let file = try AVAudioFile(forReading: url)
        var lines: [[String: Any]] = []
        var problem: String?
        let live = WhisperLive(language: language, waitForForeground: true, onChunk: { _, end, chunk in
            lines += chunk
            progress(end)
        }, onError: { problem = $0 })
        let frames = AVAudioFrameCount(file.processingFormat.sampleRate)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else {
            throw PluginError("녹음 파일을 읽지 못했어요")
        }
        while file.framePosition < file.length {
            try file.read(into: buffer, frameCount: frames)
            if buffer.frameLength == 0 { break }
            live.append(buffer)
            live.drain()
            if let problem { throw PluginError(problem) }
        }
        let done = DispatchSemaphore(value: 0)
        live.finish { done.signal() }
        done.wait()
        if let problem { throw PluginError(problem) }
        return lines
    }
}

/// Accurate captions while recording: the microphone audio is cut into ~30 s chunks at a quiet moment
/// (so words aren't split) and each chunk is transcribed by Whisper in the background. Times are seconds
/// since the recording started, the same clock as the audio file.
final class WhisperLive {
    private let queue = DispatchQueue(label: "whisper", qos: .userInitiated)
    private let language: String
    private let onChunk: (Double, Double, [[String: Any]]) -> Void
    private let onError: (String) -> Void
    private var ctx: WhisperContext?
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
    private let lock = NSLock()
    private var pending: [Float] = []
    private var pendingStart: Double = 0
    private var prompt = ""
    private static let rate = 16000
    private let waitForForeground: Bool

    /// `waitForForeground`: iPadOS allows no GPU work in the background. A file pass waits to come back;
    /// a live recording skips that chunk, so its live lines simply stay.
    init(language: String, waitForForeground: Bool = false, onChunk: @escaping (Double, Double, [[String: Any]]) -> Void, onError: @escaping (String) -> Void) {
        self.language = language
        self.waitForForeground = waitForForeground
        self.onChunk = onChunk
        self.onError = onError
        queue.async { [self] in
            ctx = WhisperContext(path: WhisperModel.path.path)
            if ctx == nil { onError("정확한 자막(Whisper) 모델을 열지 못했어요") }
        }
    }

    /// Called from the microphone tap.
    func append(_ buffer: AVAudioPCMBuffer) {
        guard let samples = resample(buffer) else { return }
        lock.lock()
        pending += samples
        var chunk: [Float]?
        var start = 0.0
        if pending.count >= 30 * Self.rate {
            let cut = quietestCut(from: 20 * Self.rate, to: 30 * Self.rate)
            chunk = Array(pending[0..<cut])
            start = pendingStart
            pending.removeFirst(cut)
            pendingStart += Double(cut) / Double(Self.rate)
        }
        lock.unlock()
        if let chunk { queue.async { [self] in run(chunk, start: start) } }
    }

    /// Blocks until everything handed over so far has been transcribed.
    func drain() {
        queue.sync {}
    }

    private func appActive() -> Bool {
        DispatchQueue.main.sync { UIApplication.shared.applicationState != .background }
    }

    /// Transcribes what is left after the recording stops, then lets the model go.
    func finish(_ done: @escaping () -> Void) {
        lock.lock()
        let rest = pending
        let start = pendingStart
        pending = []
        lock.unlock()
        queue.async { [self] in
            if rest.count > Self.rate { run(rest, start: start) }
            ctx = nil
            done()
        }
    }

    private func run(_ chunk: [Float], start: Double) {
        guard let ctx else { return }
        let duration = Double(chunk.count) / Double(Self.rate)
        var sum: Float = 0
        for s in chunk { sum += s * s }
        // A silent chunk: Whisper would invent words ("Thank you."); report it as empty.
        guard (sum / Float(chunk.count)).squareRoot() > 0.0015 else {
            onChunk(start, start + duration, [])
            return
        }
        if waitForForeground {
            while !appActive() { Thread.sleep(forTimeInterval: 1) }
        } else if !appActive() {
            return
        }
        var result = ctx.transcribe(chunk, language: language, prompt: prompt)
        if result == nil, waitForForeground { // the app left mid-chunk: once more when it is back
            while !appActive() { Thread.sleep(forTimeInterval: 1) }
            result = ctx.transcribe(chunk, language: language, prompt: prompt)
        }
        guard var segs = result else {
            if waitForForeground { onError("이 구간을 인식하지 못했어요") }
            return
        }
        // Near-silence (room noise only) makes Whisper write a stock phrase for the whole chunk.
        let stock: Set<String> = ["thank you.", "thank you", "thanks for watching!", "thank you for watching.", "you", "bye.", "감사합니다.", "시청해주셔서 감사합니다."]
        if segs.count == 1, stock.contains(segs[0].2.lowercased()) { segs = [] }
        let lines: [[String: Any]] = segs.map { ["start": start + $0.0, "end": start + min($0.1, duration), "text": $0.2] }
        prompt = String(segs.map(\.2).joined(separator: " ").suffix(200))
        onChunk(start, start + duration, lines)
    }

    /// Where to end a chunk: the start of the quietest 0.2 s between `from` and `to` samples.
    private func quietestCut(from: Int, to: Int) -> Int {
        let win = Self.rate / 5
        var best = to
        var bestE = Float.greatestFiniteMagnitude
        var i = from
        while i + win <= min(to, pending.count) {
            var e: Float = 0
            for j in i..<(i + win) { e += pending[j] * pending[j] }
            if e < bestE {
                bestE = e
                best = i + win / 2
            }
            i += win / 2
        }
        return best
    }

    private func resample(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter else { return nil }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
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
        guard error == nil, let data = out.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
    }
}
