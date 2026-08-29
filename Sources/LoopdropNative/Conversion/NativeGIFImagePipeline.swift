import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct NativeRenderedFrame {
    let image: CGImage
    let dimensions: NativePixelDimensions
}

final class NativeFrameRenderer {
    private let context: CIContext
    private let colorSpace: CGColorSpace

    init() {
        context = CIContext(options: [.cacheIntermediates: false])
        colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    }

    func render(
        pixelBuffer: CVPixelBuffer,
        preferredTransform: CGAffineTransform,
        maximumDimension: Int?
    ) throws -> NativeRenderedFrame {
        var image = CIImage(cvPixelBuffer: pixelBuffer).transformed(by: preferredTransform)
        var extent = image.extent.standardized

        guard extent.width.isFinite, extent.height.isFinite,
              extent.width > 0, extent.height > 0 else {
            throw NativeGIFConversionError.frameRenderingFailed
        }

        image = image.transformed(
            by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)
        )
        extent = image.extent.standardized

        let originalWidth = max(1, Int(extent.width.rounded()))
        let originalHeight = max(1, Int(extent.height.rounded()))
        let originalMaximum = max(originalWidth, originalHeight)

        let targetWidth: Int
        let targetHeight: Int
        if let maximumDimension, originalMaximum > maximumDimension {
            let scale = CGFloat(maximumDimension) / CGFloat(originalMaximum)
            targetWidth = max(1, Int(floor(CGFloat(originalWidth) * scale)))
            targetHeight = max(1, Int(floor(CGFloat(originalHeight) * scale)))
        } else {
            targetWidth = originalWidth
            targetHeight = originalHeight
        }

        if targetWidth != originalWidth || targetHeight != originalHeight {
            image = image.transformed(
                by: CGAffineTransform(
                    scaleX: CGFloat(targetWidth) / extent.width,
                    y: CGFloat(targetHeight) / extent.height
                )
            )
        }

        let outputRect = CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight)
        guard let renderedImage = context.createCGImage(
            image,
            from: outputRect,
            format: .RGBA8,
            colorSpace: colorSpace
        ) else {
            throw NativeGIFConversionError.frameRenderingFailed
        }

        return NativeRenderedFrame(
            image: renderedImage,
            dimensions: NativePixelDimensions(width: targetWidth, height: targetHeight)
        )
    }
}

final class NativeGIFStreamWriter {
    private let outputURL: URL
    private let destination: CGImageDestination
    private let frameDelays: [TimeInterval]
    private var addedFrameCount = 0
    private var isFinalized = false

    init(
        outputURL: URL,
        frameCount: Int,
        framesPerSecond: Double,
        duration: TimeInterval,
        loopCount: Int
    ) throws {
        self.outputURL = outputURL

        // GIF requires whole-centisecond, positive delays. Quantize cumulative
        // ideal time while reserving at least one centisecond for every frame.
        // This lets a short final frame borrow from an earlier frame instead of
        // extending the animation beyond the nearest representable duration.
        let totalCentiseconds = max(frameCount, Int((duration * 100).rounded()))
        var delays: [TimeInterval] = []
        delays.reserveCapacity(frameCount)
        var emittedCentiseconds = 0
        for index in 0..<frameCount {
            let remainingFrames = frameCount - index - 1
            let idealCumulative = min(
                Int((Double(index + 1) * 100 / framesPerSecond).rounded()),
                totalCentiseconds
            )
            let latestAllowedCumulative = totalCentiseconds - remainingFrames
            let targetCumulative = min(
                max(idealCumulative, emittedCentiseconds + 1),
                latestAllowedCumulative
            )
            let delayCentiseconds = targetCumulative - emittedCentiseconds
            guard delayCentiseconds <= Int(UInt16.max) else {
                throw NativeGIFConversionError.gifFrameDelayLimitExceeded
            }
            delays.append(Double(delayCentiseconds) / 100)
            emittedCentiseconds = targetCumulative
        }
        frameDelays = delays

        guard let destination = CGImageDestinationCreateWithURL(
            outputURL as CFURL,
            UTType.gif.identifier as CFString,
            frameCount,
            nil
        ) else {
            throw NativeGIFConversionError.destinationCreationFailed(outputURL)
        }
        self.destination = destination

        let gifProperties = [
            kCGImagePropertyGIFLoopCount as String: loopCount,
        ]
        CGImageDestinationSetProperties(destination, [
            kCGImagePropertyGIFDictionary as String: gifProperties,
        ] as CFDictionary)
    }

    func add(_ image: CGImage) {
        guard addedFrameCount < frameDelays.count else {
            assertionFailure("Attempted to add more GIF frames than planned")
            return
        }
        let delay = frameDelays[addedFrameCount]
        addedFrameCount += 1

        let frameProperties = [
            kCGImagePropertyGIFDictionary as String: [
                kCGImagePropertyGIFDelayTime as String: delay,
                kCGImagePropertyGIFUnclampedDelayTime as String: delay,
            ],
        ] as CFDictionary
        CGImageDestinationAddImage(destination, image, frameProperties)
    }

    func finalize() throws {
        guard !isFinalized else { return }
        guard CGImageDestinationFinalize(destination) else {
            throw NativeGIFConversionError.destinationFinalizationFailed(outputURL)
        }
        isFinalized = true
    }
}
