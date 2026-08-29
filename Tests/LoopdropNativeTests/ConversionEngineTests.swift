import AVFoundation
import CoreGraphics
import CoreVideo
import ImageIO
import XCTest
@testable import LoopdropNative

final class ConversionEngineTests: XCTestCase {
    func testProbeAndConvertGeneratedRotatedVideo() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("rotated.mov")
        try await makeFixtureVideo(at: sourceURL)

        let converter = NativeGIFConverter()
        let metadata = try await converter.probe(sourceURL)
        XCTAssertEqual(metadata.naturalDimensions, NativePixelDimensions(width: 64, height: 32))
        XCTAssertEqual(metadata.displayDimensions, NativePixelDimensions(width: 32, height: 64))
        XCTAssertEqual(metadata.orientation, .right)
        XCTAssertEqual(metadata.nominalFrameRate, 10, accuracy: 0.1)
        XCTAssertEqual(metadata.duration, 2, accuracy: 0.05)

        let outputURL = directory.appendingPathComponent("result.gif")
        let request = NativeGIFConversionRequest(
            sourceURL: sourceURL,
            startTime: 0.2,
            duration: 1,
            framesPerSecond: 15,
            maximumDimension: .pixels(40),
            loopCount: 0,
            destination: .file(outputURL)
        )
        let result = try await converter.convert(request)

        XCTAssertEqual(result.outputURL, outputURL)
        XCTAssertEqual(result.frameCount, 15)
        XCTAssertEqual(result.sourceDuration, 1, accuracy: 0.001)
        XCTAssertEqual(result.outputDimensions, NativePixelDimensions(width: 20, height: 40))
        XCTAssertGreaterThan(result.fileSizeBytes, 0)

        try assertGIF(
            at: outputURL,
            expectedFrames: 15,
            expectedDimensions: NativePixelDimensions(width: 20, height: 40),
            expectedDelay: 1 / 15
        )
    }

    func testUpsamplingHoldsEachSourceFrameUntilItsPresentationTime() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("two-fps.mov")
        try await makeFixtureVideo(at: sourceURL, frameRate: 2, frameCount: 4)

        let outputURL = directory.appendingPathComponent("ten-fps.gif")
        let result = try await NativeGIFConverter().convert(NativeGIFConversionRequest(
            sourceURL: sourceURL,
            duration: 1,
            framesPerSecond: 10,
            destination: .file(outputURL)
        ))

        XCTAssertEqual(result.frameCount, 10)
        let fingerprints = try gifFrameFingerprints(at: outputURL)
        XCTAssertEqual(fingerprints.count, 10)
        XCTAssertEqual(Set(fingerprints[0..<5]).count, 1)
        XCTAssertEqual(Set(fingerprints[5..<10]).count, 1)
        XCTAssertNotEqual(fingerprints[0], fingerprints[5])
    }

    func testFractionalClipDurationIsPreservedToTheNearestCentisecond() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("fractional.mov")
        try await makeFixtureVideo(at: sourceURL)
        let outputURL = directory.appendingPathComponent("fractional.gif")

        let result = try await NativeGIFConverter().convert(NativeGIFConversionRequest(
            sourceURL: sourceURL,
            duration: 1.001,
            framesPerSecond: 15,
            destination: .file(outputURL)
        ))

        XCTAssertEqual(result.frameCount, 16)
        let totalDelay = try gifFrameDelays(at: outputURL).reduce(0, +)
        XCTAssertEqual(totalDelay, 1.00, accuracy: 0.001)
    }

    func testUnrepresentableGIFFrameDelayFailsBeforeCreatingOutput() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let outputURL = directory.appendingPathComponent("too-long.gif")

        XCTAssertThrowsError(try NativeGIFStreamWriter(
            outputURL: outputURL,
            frameCount: 1,
            framesPerSecond: 0.001,
            duration: 1_000,
            loopCount: 0
        )) { error in
            XCTAssertEqual(
                error as? NativeGIFConversionError,
                .gifFrameDelayLimitExceeded
            )
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: outputURL.path))
    }

    func testFrameLimitExactDestinationCollisionAndCancellationCleanup() async throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("fixture.mov")
        try await makeFixtureVideo(at: sourceURL)
        let converter = NativeGIFConverter()

        let overLimitURL = directory.appendingPathComponent("over-limit.gif")
        do {
            _ = try await converter.convert(NativeGIFConversionRequest(
                sourceURL: sourceURL,
                duration: 2,
                framesPerSecond: 151,
                destination: .file(overLimitURL)
            ))
            XCTFail("Expected the 300-frame limit to be enforced")
        } catch let error as NativeGIFConversionError {
            XCTAssertEqual(error, .frameLimitExceeded(requested: 302, maximum: 300))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: overLimitURL.path))

        let existingURL = directory.appendingPathComponent("existing.gif")
        try Data("keep".utf8).write(to: existingURL)
        do {
            _ = try await converter.convert(NativeGIFConversionRequest(
                sourceURL: sourceURL,
                duration: 0.5,
                framesPerSecond: 5,
                destination: .file(existingURL)
            ))
            XCTFail("Expected an exact destination collision")
        } catch let error as NativeGIFConversionError {
            XCTAssertEqual(error, .outputAlreadyExists(existingURL))
        }
        XCTAssertEqual(try Data(contentsOf: existingURL), Data("keep".utf8))

        let cancelledURL = directory.appendingPathComponent("cancelled.gif")
        do {
            _ = try await converter.convert(
                NativeGIFConversionRequest(
                    sourceURL: sourceURL,
                    duration: 2,
                    framesPerSecond: 50,
                    destination: .file(cancelledURL)
                ),
                progress: { update in
                    guard update.stage == .decoding, update.completedFrames > 0 else { return }
                    withUnsafeCurrentTask { $0?.cancel() }
                }
            )
            XCTFail("Expected cancellation")
        } catch let error as NativeGIFConversionError {
            XCTAssertEqual(error, .cancelled)
        }

        XCTAssertFalse(FileManager.default.fileExists(atPath: cancelledURL.path))
        let leftovers = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ).filter { $0.lastPathComponent.contains("loopdrop-partial") }
        XCTAssertTrue(leftovers.isEmpty, "Leftover files: \(leftovers.map(\.lastPathComponent))")
    }

    func testOutputTransactionNeverOverwritesOrDeletesARacingFile() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let sourceURL = directory.appendingPathComponent("source.mov")
        let destinationURL = directory.appendingPathComponent("result.gif")
        let transaction = try NativeOutputTransaction.begin(
            for: .file(destinationURL),
            sourceURL: sourceURL
        )
        try Data("encoded GIF".utf8).write(to: transaction.temporaryURL)

        let foreignContents = Data("created by another process".utf8)
        try foreignContents.write(to: destinationURL)

        do {
            try transaction.commit()
            XCTFail("Atomic no-replace finalization should reject a racing destination")
        } catch let error as NativeGIFConversionError {
            XCTAssertEqual(error, .outputAlreadyExists(destinationURL))
        }

        transaction.cancel()
        XCTAssertEqual(try Data(contentsOf: destinationURL), foreignContents)
        XCTAssertFalse(FileManager.default.fileExists(atPath: transaction.temporaryURL.path))

        let cancelledDestinationURL = directory.appendingPathComponent("cancel-race.gif")
        let cancelledTransaction = try NativeOutputTransaction.begin(
            for: .file(cancelledDestinationURL),
            sourceURL: sourceURL
        )
        try Data("partial GIF".utf8).write(to: cancelledTransaction.temporaryURL)
        try foreignContents.write(to: cancelledDestinationURL)
        cancelledTransaction.cancel()
        XCTAssertEqual(try Data(contentsOf: cancelledDestinationURL), foreignContents)
    }

    func testConfiguredRealVideo() async throws {
        guard let path = ProcessInfo.processInfo.environment["LOOPDROP_SAMPLE_VIDEO"],
              !path.isEmpty else {
            throw XCTSkip("Set LOOPDROP_SAMPLE_VIDEO to run the real-file integration test.")
        }

        let sourceURL = URL(fileURLWithPath: path)
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let converter = NativeGIFConverter()
        let metadata = try await converter.probe(sourceURL)
        let selectedDuration = min(metadata.duration, 5)
        let outputURL = directory.appendingPathComponent("real-sample.gif")
        let startedAt = Date()
        let result = try await converter.convert(NativeGIFConversionRequest(
            sourceURL: sourceURL,
            duration: selectedDuration,
            framesPerSecond: 15,
            maximumDimension: .large,
            destination: .file(outputURL)
        ))
        let elapsed = Date().timeIntervalSince(startedAt)

        print(
            String(
                format: "Loopdrop benchmark: %.3fs, %d frames, %lld bytes, %dx%d",
                elapsed,
                result.frameCount,
                result.fileSizeBytes,
                result.outputDimensions.width,
                result.outputDimensions.height
            )
        )

        XCTAssertGreaterThan(result.frameCount, 0)
        XCTAssertLessThanOrEqual(result.frameCount, NativeGIFConverter.maximumFrameCount)
        XCTAssertLessThanOrEqual(result.outputDimensions.maximum, 720)
        try assertGIF(
            at: outputURL,
            expectedFrames: result.frameCount,
            expectedDimensions: result.outputDimensions,
            expectedDelay: 1 / 15
        )
    }

    private func assertGIF(
        at url: URL,
        expectedFrames: Int,
        expectedDimensions: NativePixelDimensions,
        expectedDelay: TimeInterval
    ) throws {
        let signature = try Data(contentsOf: url).prefix(6)
        XCTAssertTrue(
            signature == Data("GIF87a".utf8) || signature == Data("GIF89a".utf8),
            "The output did not have a GIF signature"
        )

        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            return XCTFail("ImageIO could not reopen the generated GIF")
        }
        XCTAssertEqual(CGImageSourceGetCount(source), expectedFrames)

        var frameFingerprints = Set<UInt64>()
        var totalDelay: TimeInterval = 0
        for index in 0..<expectedFrames {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else {
                XCTFail("ImageIO could not decode GIF frame \(index)")
                continue
            }
            XCTAssertEqual(image.width, expectedDimensions.width, "Frame \(index) width")
            XCTAssertEqual(image.height, expectedDimensions.height, "Frame \(index) height")
            frameFingerprints.insert(pixelFingerprint(of: image))

            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [String: Any]
            let gifProperties = properties?[kCGImagePropertyGIFDictionary as String] as? [String: Any]
            let delay = (gifProperties?[kCGImagePropertyGIFUnclampedDelayTime as String] as? NSNumber)
                ?? (gifProperties?[kCGImagePropertyGIFDelayTime as String] as? NSNumber)
            XCTAssertNotNil(delay, "Frame \(index) has no delay")
            totalDelay += delay?.doubleValue ?? 0
            XCTAssertEqual(
                delay?.doubleValue ?? 0,
                expectedDelay,
                accuracy: 0.011,
                "Frame \(index) delay"
            )
        }
        if expectedFrames > 1 {
            XCTAssertGreaterThan(frameFingerprints.count, 1, "All GIF frames have identical pixels")
        }
        XCTAssertEqual(
            totalDelay,
            Double(expectedFrames) * expectedDelay,
            accuracy: 0.011,
            "The GIF's cumulative frame delay changed its total duration"
        )
    }

    private func pixelFingerprint(of image: CGImage) -> UInt64 {
        let bytesPerRow = image.width * 4
        var pixels = [UInt8](repeating: 0, count: bytesPerRow * image.height)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        pixels.withUnsafeMutableBytes { storage in
            guard let context = CGContext(
                data: storage.baseAddress,
                width: image.width,
                height: image.height,
                bitsPerComponent: 8,
                bytesPerRow: bytesPerRow,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }

        return pixels.reduce(UInt64(1_469_598_103_934_665_603)) { hash, byte in
            (hash ^ UInt64(byte)) &* 1_099_511_628_211
        }
    }

    private func gifFrameFingerprints(at url: URL) throws -> [UInt64] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw FixtureError("ImageIO could not open the generated GIF")
        }
        return try (0..<CGImageSourceGetCount(source)).map { index in
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else {
                throw FixtureError("ImageIO could not decode GIF frame \(index)")
            }
            return pixelFingerprint(of: image)
        }
    }

    private func gifFrameDelays(at url: URL) throws -> [TimeInterval] {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw FixtureError("ImageIO could not open the generated GIF")
        }
        return try (0..<CGImageSourceGetCount(source)).map { index in
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil)
                as? [String: Any]
            let gifProperties = properties?[kCGImagePropertyGIFDictionary as String]
                as? [String: Any]
            guard let delay = (gifProperties?[kCGImagePropertyGIFUnclampedDelayTime as String]
                as? NSNumber)
                ?? (gifProperties?[kCGImagePropertyGIFDelayTime as String] as? NSNumber) else {
                throw FixtureError("GIF frame \(index) has no delay")
            }
            return delay.doubleValue
        }
    }

    private func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("LoopdropNativeTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func makeFixtureVideo(
        at url: URL,
        frameRate: Int32 = 10,
        frameCount: Int = 20
    ) async throws {
        let width = 64
        let height = 32

        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = false
        input.transform = CGAffineTransform(
            a: 0,
            b: 1,
            c: -1,
            d: 0,
            tx: CGFloat(height),
            ty: 0
        )

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )

        guard writer.canAdd(input) else {
            throw FixtureError("AVAssetWriter rejected the test video input")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw FixtureError(writer.error?.localizedDescription ?? "AVAssetWriter did not start")
        }
        writer.startSession(atSourceTime: .zero)

        guard let pool = adaptor.pixelBufferPool else {
            throw FixtureError("AVAssetWriter did not create a pixel buffer pool")
        }

        for index in 0..<frameCount {
            while !input.isReadyForMoreMediaData {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 1_000_000)
            }

            var optionalBuffer: CVPixelBuffer?
            let status = CVPixelBufferPoolCreatePixelBuffer(nil, pool, &optionalBuffer)
            guard status == kCVReturnSuccess, let pixelBuffer = optionalBuffer else {
                throw FixtureError("Could not allocate test pixel buffer (\(status))")
            }
            fill(pixelBuffer: pixelBuffer, frameIndex: index)

            let presentationTime = CMTime(value: CMTimeValue(index), timescale: frameRate)
            guard adaptor.append(pixelBuffer, withPresentationTime: presentationTime) else {
                throw FixtureError(writer.error?.localizedDescription ?? "Could not append test frame")
            }
        }

        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw FixtureError(writer.error?.localizedDescription ?? "Could not finish test video")
        }
    }

    private func fill(pixelBuffer: CVPixelBuffer, frameIndex: Int) {
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)

        for y in 0..<height {
            let row = baseAddress.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let offset = x * 4
                row[offset] = UInt8((frameIndex * 17) % 255)
                row[offset + 1] = UInt8((x * 4) % 255)
                row[offset + 2] = UInt8((y * 8) % 255)
                row[offset + 3] = 255
            }
        }
    }
}

private struct FixtureError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
}
