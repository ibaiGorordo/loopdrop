@preconcurrency import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation

public struct NativeGIFConverter: NativeGIFConverting {
    public static let maximumFrameCount = 300

    public init() {}

    public func probe(_ sourceURL: URL) async throws -> NativeVideoMetadata {
        let hasSecurityScope = sourceURL.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityScope {
                sourceURL.stopAccessingSecurityScopedResource()
            }
        }

        do {
            try Task.checkCancellation()
            return try await NativeVideoProbeLoader.load(sourceURL).metadata
        } catch is CancellationError {
            throw NativeGIFConversionError.cancelled
        }
    }

    public func convert(
        _ request: NativeGIFConversionRequest,
        progress: @escaping NativeGIFProgressHandler
    ) async throws -> NativeGIFConversionResult {
        let hasSecurityScope = request.sourceURL.startAccessingSecurityScopedResource()
        defer {
            if hasSecurityScope {
                request.sourceURL.stopAccessingSecurityScopedResource()
            }
        }

        do {
            try Task.checkCancellation()
            await progress(NativeGIFProgress(
                stage: .preparing,
                fractionCompleted: 0,
                completedFrames: 0,
                totalFrames: 0
            ))

            let loadedVideo = try await NativeVideoProbeLoader.load(request.sourceURL)
            let plan = try NativeGIFFramePlan(request: request, metadata: loadedVideo.metadata)
            try Task.checkCancellation()

            await progress(NativeGIFProgress(
                stage: .preparing,
                fractionCompleted: 0,
                completedFrames: 0,
                totalFrames: plan.frameCount
            ))

            return try await performConversion(
                request: request,
                loadedVideo: loadedVideo,
                plan: plan,
                progress: progress
            )
        } catch is CancellationError {
            throw NativeGIFConversionError.cancelled
        } catch let error as NativeGIFConversionError {
            throw error
        } catch {
            throw NativeGIFConversionError.readerFailed(reason: error.localizedDescription)
        }
    }

    private func performConversion(
        request: NativeGIFConversionRequest,
        loadedVideo: NativeLoadedVideo,
        plan: NativeGIFFramePlan,
        progress: @escaping NativeGIFProgressHandler
    ) async throws -> NativeGIFConversionResult {
        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: loadedVideo.asset)
        } catch {
            throw NativeGIFConversionError.readerCreationFailed(reason: error.localizedDescription)
        }

        let outputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ]
        let trackOutput = AVAssetReaderTrackOutput(
            track: loadedVideo.track,
            outputSettings: outputSettings
        )
        trackOutput.alwaysCopiesSampleData = false

        guard reader.canAdd(trackOutput) else {
            throw NativeGIFConversionError.readerConfigurationFailed
        }
        reader.add(trackOutput)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: plan.startTime, preferredTimescale: 60_000),
            duration: CMTime(seconds: plan.duration, preferredTimescale: 60_000)
        )

        guard reader.startReading() else {
            throw NativeGIFConversionError.readerFailed(
                reason: reader.error?.localizedDescription ?? "The reader did not start."
            )
        }
        defer {
            if reader.status == .reading {
                reader.cancelReading()
            }
        }

        let transaction = try NativeOutputTransaction.begin(
            for: request.destination,
            sourceURL: request.sourceURL
        )
        defer { transaction.cancel() }

        let writer = try NativeGIFStreamWriter(
            outputURL: transaction.temporaryURL,
            frameCount: plan.frameCount,
            framesPerSecond: plan.framesPerSecond,
            duration: plan.duration,
            loopCount: request.loopCount
        )
        let renderer = NativeFrameRenderer()

        func render(_ pixelBuffer: CVPixelBuffer) throws -> NativeRenderedFrame {
            try autoreleasepool {
                try renderer.render(
                    pixelBuffer: pixelBuffer,
                    preferredTransform: loadedVideo.preferredTransform,
                    maximumDimension: request.maximumDimension.pixels
                )
            }
        }

        var completedFrames = 0
        var outputDimensions: NativePixelDimensions?
        var lastRenderedFrame: NativeRenderedFrame?
        var pendingPixelBuffer: CVPixelBuffer?
        var pendingRenderedFrame: NativeRenderedFrame?

        while completedFrames < plan.frameCount {
            try Task.checkCancellation()

            guard let sampleBuffer = trackOutput.copyNextSampleBuffer() else { break }
            let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            guard presentationTime.isNumeric else { continue }

            let sampleTime = presentationTime.seconds
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
            let framesBeforeSample = completedFrames

            // Hold the previous decoded image until this sample's presentation
            // time. Using the future image for earlier output instants makes
            // low- or variable-frame-rate sources play ahead of their timeline.
            // Rendering is deferred until a decoded sample is actually selected,
            // so high-frame-rate sources do not pay to scale discarded frames.
            if let pendingPixelBuffer {
                var heldFrame = pendingRenderedFrame
                while completedFrames < plan.frameCount {
                    let targetTime = plan.startTime
                        + (Double(completedFrames) / plan.framesPerSecond)
                    if targetTime + 0.000_001 >= sampleTime { break }
                    if heldFrame == nil {
                        heldFrame = try render(pendingPixelBuffer)
                    }
                    writer.add(heldFrame!.image)
                    completedFrames += 1
                }
                if let heldFrame {
                    outputDimensions = heldFrame.dimensions
                    lastRenderedFrame = heldFrame
                }
            }

            pendingPixelBuffer = pixelBuffer
            pendingRenderedFrame = nil

            while completedFrames < plan.frameCount {
                let targetTime = plan.startTime
                    + (Double(completedFrames) / plan.framesPerSecond)
                if targetTime > sampleTime + 0.000_001 { break }
                if pendingRenderedFrame == nil {
                    pendingRenderedFrame = try render(pixelBuffer)
                }
                writer.add(pendingRenderedFrame!.image)
                completedFrames += 1
            }
            if let pendingRenderedFrame {
                outputDimensions = pendingRenderedFrame.dimensions
                lastRenderedFrame = pendingRenderedFrame
            }

            if completedFrames != framesBeforeSample {
                await progress(NativeGIFProgress(
                    stage: .decoding,
                    fractionCompleted: Double(completedFrames) / Double(plan.frameCount),
                    completedFrames: completedFrames,
                    totalFrames: plan.frameCount
                ))
            }
        }

        try Task.checkCancellation()
        if reader.status == .failed {
            throw NativeGIFConversionError.readerFailed(
                reason: reader.error?.localizedDescription ?? "AVAssetReader failed."
            )
        }
        if reader.status == .cancelled {
            throw NativeGIFConversionError.cancelled
        }

        // A source can end between requested sample instants. Repeating only the final
        // frame preserves the requested GIF duration without retaining a frame array.
        if completedFrames < plan.frameCount {
            guard let pendingPixelBuffer else {
                throw NativeGIFConversionError.noFramesDecoded
            }
            let finalFrame = try pendingRenderedFrame ?? render(pendingPixelBuffer)
            outputDimensions = finalFrame.dimensions
            lastRenderedFrame = finalFrame
            autoreleasepool {
                while completedFrames < plan.frameCount {
                    writer.add(finalFrame.image)
                    completedFrames += 1
                }
            }
            await progress(NativeGIFProgress(
                stage: .decoding,
                fractionCompleted: 1,
                completedFrames: completedFrames,
                totalFrames: plan.frameCount
            ))
        }

        guard lastRenderedFrame != nil, let outputDimensions else {
            throw NativeGIFConversionError.noFramesDecoded
        }

        try Task.checkCancellation()
        await progress(NativeGIFProgress(
            stage: .finalizing,
            fractionCompleted: 1,
            completedFrames: completedFrames,
            totalFrames: plan.frameCount
        ))

        try writer.finalize()
        try Task.checkCancellation()
        try transaction.commit()

        let fileSize = (try? transaction.destinationURL.resourceValues(
            forKeys: [.fileSizeKey]
        ).fileSize).map(Int64.init) ?? 0

        let result = NativeGIFConversionResult(
            sourceURL: request.sourceURL,
            outputURL: transaction.destinationURL,
            metadata: loadedVideo.metadata,
            frameCount: completedFrames,
            sourceDuration: plan.duration,
            outputDimensions: outputDimensions,
            fileSizeBytes: fileSize
        )

        await progress(NativeGIFProgress(
            stage: .completed,
            fractionCompleted: 1,
            completedFrames: completedFrames,
            totalFrames: plan.frameCount
        ))
        return result
    }
}

private struct NativeGIFFramePlan {
    let startTime: TimeInterval
    let duration: TimeInterval
    let framesPerSecond: Double
    let frameCount: Int

    init(request: NativeGIFConversionRequest, metadata: NativeVideoMetadata) throws {
        guard request.framesPerSecond.isFinite, request.framesPerSecond > 0 else {
            throw NativeGIFConversionError.invalidFrameRate(request.framesPerSecond)
        }
        guard request.startTime.isFinite,
              request.startTime >= 0,
              request.startTime < metadata.duration else {
            throw NativeGIFConversionError.invalidStartTime(request.startTime)
        }
        if let requestedDuration = request.duration {
            guard requestedDuration.isFinite, requestedDuration > 0 else {
                throw NativeGIFConversionError.invalidDuration(requestedDuration)
            }
        }
        if let maximumDimension = request.maximumDimension.pixels,
           maximumDimension <= 0 {
            throw NativeGIFConversionError.invalidMaximumDimension(maximumDimension)
        }
        guard request.loopCount >= 0 else {
            throw NativeGIFConversionError.invalidLoopCount(request.loopCount)
        }

        let remainingDuration = metadata.duration - request.startTime
        let selectedDuration = min(request.duration ?? remainingDuration, remainingDuration)
        guard selectedDuration.isFinite, selectedDuration > 0 else {
            throw NativeGIFConversionError.invalidDuration(selectedDuration)
        }

        let rawFrameCount = ceil(selectedDuration * request.framesPerSecond)
        guard rawFrameCount.isFinite, rawFrameCount > 0 else {
            throw NativeGIFConversionError.invalidFrameRate(request.framesPerSecond)
        }

        if rawFrameCount > Double(NativeGIFConverter.maximumFrameCount) {
            let reportedCount = rawFrameCount >= Double(Int.max)
                ? Int.max
                : Int(rawFrameCount)
            throw NativeGIFConversionError.frameLimitExceeded(
                requested: reportedCount,
                maximum: NativeGIFConverter.maximumFrameCount
            )
        }

        startTime = request.startTime
        duration = selectedDuration
        framesPerSecond = request.framesPerSecond
        frameCount = max(1, Int(rawFrameCount))
    }
}
