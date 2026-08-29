import AppKit
@preconcurrency import AVFoundation
import SwiftUI

@MainActor
final class LoopdropViewModel: ObservableObject {
    enum Activity: Equatable {
        case idle
        case probing
        case ready
        case converting
        case cancelling
        case complete
        case failed
    }

    @Published private(set) var inputURL: URL?
    @Published private(set) var metadata: NativeVideoMetadata?
    @Published private(set) var activity: Activity = .idle
    @Published private(set) var progress = 0.0
    @Published private(set) var statusMessage = "Drop a video to begin"
    @Published private(set) var outputURL: URL?
    @Published private(set) var isPreviewPlaying = false

    let preferences: LoopdropPreferences
    let previewPlayer = AVPlayer()

    private let converter: any NativeGIFConverting
    private var probeTask: Task<Void, Never>?
    private var conversionTask: Task<Void, Never>?
    private var probeGeneration = 0
    private var previewEndObserver: NSObjectProtocol?
    private var isPreviewVisible = false
    private var conversionActivity: NSObjectProtocol?

    init(
        converter: any NativeGIFConverting,
        preferences: LoopdropPreferences? = nil
    ) {
        self.converter = converter
        self.preferences = preferences ?? LoopdropPreferences()
        previewPlayer.isMuted = true
        previewPlayer.actionAtItemEnd = .pause
        previewPlayer.automaticallyWaitsToMinimizeStalling = false
        previewPlayer.preventsDisplaySleepDuringVideoPlayback = false
    }

    var isConverting: Bool {
        activity == .converting || activity == .cancelling
    }

    var canConvert: Bool {
        inputURL != nil && metadata != nil && !isConverting
    }

    var inputDescription: String? {
        guard let metadata else { return nil }
        let duration = Self.durationFormatter.string(from: metadata.duration) ?? "0:00"
        return "\(duration) · \(metadata.displayDimensions.width)×\(metadata.displayDimensions.height)"
    }

    var displayedStatusMessage: String {
        guard activity == .ready, statusMessage == "Ready", let metadata,
              preferences.clipLength == .full else {
            return statusMessage
        }
        let preferredRate = preferences.quality.framesPerSecond
        let effectiveRate = effectiveFullFrameRate(for: metadata.duration, preferred: preferredRate)
        guard effectiveRate < preferredRate else { return statusMessage }
        let formattedRate = effectiveRate >= 1
            ? String(format: "%.1f", effectiveRate)
            : String(format: "%.2f", effectiveRate)
        return "Full video · \(formattedRate) fps"
    }

    func acceptInput(_ url: URL) {
        guard url.isFileURL, !isConverting else { return }

        probeTask?.cancel()
        probeGeneration &+= 1
        let generation = probeGeneration
        let normalizedURL = url.standardizedFileURL
        inputURL = normalizedURL
        metadata = nil
        outputURL = nil
        progress = 0
        activity = .probing
        statusMessage = "Reading video…"

        tearDownPreview()
        if isPreviewVisible {
            preparePreview(autoplay: preferences.playPreview)
        }

        probeTask = Task { [weak self, converter] in
            guard let self else { return }
            defer {
                if self.probeGeneration == generation {
                    self.probeTask = nil
                }
            }
            do {
                let metadata = try await converter.probe(normalizedURL)
                try Task.checkCancellation()
                guard self.probeGeneration == generation else { return }
                self.metadata = metadata
                self.activity = .ready
                self.statusMessage = "Ready"
            } catch is CancellationError {
                return
            } catch let error as NativeGIFConversionError {
                if case .cancelled = error { return }
                guard self.probeGeneration == generation else { return }
                self.activity = .failed
                self.statusMessage = Self.conciseMessage(for: error)
            } catch {
                guard self.probeGeneration == generation else { return }
                self.activity = .failed
                self.statusMessage = Self.conciseMessage(for: error)
            }
        }
    }

    func clearInput() {
        guard !isConverting else { return }
        probeTask?.cancel()
        probeGeneration &+= 1
        probeTask = nil
        tearDownPreview()
        inputURL = nil
        metadata = nil
        outputURL = nil
        progress = 0
        activity = .idle
        statusMessage = "Drop a video to begin"
    }

    func togglePreviewPlayback() {
        guard inputURL != nil else { return }
        if isPreviewPlaying {
            previewPlayer.pause()
            isPreviewPlaying = false
        } else {
            if previewPlayer.currentItem == nil {
                preparePreview(autoplay: false)
            }
            let duration = previewPlayer.currentItem?.duration.seconds ?? 0
            let currentTime = previewPlayer.currentTime().seconds
            if duration.isFinite, currentTime.isFinite, currentTime >= duration - 0.05 {
                previewPlayer.seek(to: .zero)
            }
            previewPlayer.play()
            isPreviewPlaying = true
        }
    }

    func setPreviewVisible(_ isVisible: Bool) {
        isPreviewVisible = isVisible
        if isVisible {
            preparePreview(autoplay: preferences.playPreview && !isConverting)
        } else {
            // The converter owns its own AVAssetReader. Releasing the playback item
            // here cannot interrupt a conversion running after the popover closes.
            tearDownPreview()
        }
    }

    func startConversion() {
        guard let inputURL, let metadata, canConvert else { return }

        let preferredFrameRate = preferences.quality.framesPerSecond
        let selectedDuration = min(preferences.clipLength.seconds ?? metadata.duration, metadata.duration)
        let framesPerSecond = preferences.clipLength == .full
            ? effectiveFullFrameRate(for: selectedDuration, preferred: preferredFrameRate)
            : preferredFrameRate
        let request = NativeGIFConversionRequest(
            sourceURL: inputURL,
            duration: selectedDuration,
            framesPerSecond: framesPerSecond,
            maximumDimension: .pixels(preferences.quality.maximumDimension),
            destination: .downloads
        )

        outputURL = nil
        progress = 0
        activity = .converting
        statusMessage = "Preparing…"
        previewPlayer.pause()
        isPreviewPlaying = false
        beginConversionActivity()

        conversionTask = Task { [weak self, converter] in
            guard let self else { return }
            defer {
                self.conversionTask = nil
                self.endConversionActivity()
            }
            do {
                let result = try await converter.convert(request) { [weak self] update in
                    guard let self else { return }
                    self.progress = min(max(update.fractionCompleted, 0), 1)
                    switch update.stage {
                    case .preparing:
                        self.statusMessage = "Preparing…"
                    case .decoding:
                        self.statusMessage = "Creating GIF…"
                    case .finalizing:
                        self.statusMessage = "Finishing…"
                    case .completed:
                        self.statusMessage = "GIF ready"
                    }
                }
                // Returning from the converter means the GIF was already
                // atomically committed. A late Cancel must not hide that result.
                self.outputURL = result.outputURL
                self.progress = 1
                self.activity = .complete
                self.statusMessage = "GIF ready"
                if self.preferences.revealOutput {
                    self.revealOutput()
                }
                self.resumePreviewIfAppropriate()
            } catch is CancellationError {
                self.finishCancellation()
            } catch let error as NativeGIFConversionError {
                if case .cancelled = error {
                    self.finishCancellation()
                } else {
                    self.finishFailure(error)
                }
            } catch {
                self.finishFailure(error)
            }
        }
    }

    func cancelConversion() {
        guard activity == .converting else { return }
        activity = .cancelling
        statusMessage = "Cancelling…"
        conversionTask?.cancel()
    }

    func cancelConversionAndWait() async {
        guard let conversionTask else { return }
        if activity == .converting {
            activity = .cancelling
            statusMessage = "Cancelling…"
        }
        conversionTask.cancel()
        await conversionTask.value
    }

    func revealOutput() {
        guard let outputURL else { return }
        NSWorkspace.shared.activateFileViewerSelecting([outputURL])
    }

    private func finishCancellation() {
        progress = 0
        activity = .ready
        statusMessage = "Cancelled"
        resumePreviewIfAppropriate()
    }

    private func finishFailure(_ error: Error) {
        progress = 0
        activity = .failed
        statusMessage = Self.conciseMessage(for: error)
        resumePreviewIfAppropriate()
    }

    private func preparePreview(autoplay: Bool) {
        guard isPreviewVisible, let inputURL else { return }
        if previewPlayer.currentItem == nil {
            let item = AVPlayerItem(url: inputURL)
            // The compact preview is about 300 backing pixels wide. Asking AVFoundation
            // for full-resolution decoded frames wastes hundreds of MB on local files.
            item.preferredMaximumResolution = CGSize(width: 640, height: 640)
            item.preferredForwardBufferDuration = 0.5
            item.canUseNetworkResourcesForLiveStreamingWhilePaused = false
            previewPlayer.replaceCurrentItem(with: item)
            observePreviewEnd(of: item)
        }
        guard autoplay else {
            isPreviewPlaying = false
            return
        }
        previewPlayer.play()
        isPreviewPlaying = true
    }

    private func tearDownPreview() {
        if let previewEndObserver {
            NotificationCenter.default.removeObserver(previewEndObserver)
            self.previewEndObserver = nil
        }
        previewPlayer.pause()
        previewPlayer.currentItem?.cancelPendingSeeks()
        previewPlayer.replaceCurrentItem(with: nil)
        isPreviewPlaying = false
    }

    private func observePreviewEnd(of item: AVPlayerItem) {
        if let previewEndObserver {
            NotificationCenter.default.removeObserver(previewEndObserver)
        }
        previewEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.previewPlayer.pause()
                self?.isPreviewPlaying = false
            }
        }
    }

    private func resumePreviewIfAppropriate() {
        guard isPreviewVisible, preferences.playPreview else { return }
        let duration = previewPlayer.currentItem?.duration.seconds ?? 0
        let currentTime = previewPlayer.currentTime().seconds
        if duration.isFinite, currentTime.isFinite, currentTime >= duration - 0.05 {
            previewPlayer.seek(to: .zero)
        }
        previewPlayer.play()
        isPreviewPlaying = true
    }

    private func effectiveFullFrameRate(for duration: TimeInterval, preferred: Double) -> Double {
        guard duration.isFinite, duration > 0 else { return preferred }
        let frameLimitedRate = (Double(Self.maximumFrameCount) / duration).nextDown
        return min(preferred, frameLimitedRate)
    }

    private func beginConversionActivity() {
        guard conversionActivity == nil else { return }
        conversionActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated],
            reason: "Creating a GIF"
        )
    }

    private func endConversionActivity() {
        guard let conversionActivity else { return }
        ProcessInfo.processInfo.endActivity(conversionActivity)
        self.conversionActivity = nil
    }

    private static let durationFormatter: DateComponentsFormatter = {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.minute, .second]
        formatter.zeroFormattingBehavior = [.pad]
        return formatter
    }()

    private static let maximumFrameCount = 300

    private static func conciseMessage(for error: Error) -> String {
        let message = (error as NSError).localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "Couldn’t process this video" : message
    }
}
