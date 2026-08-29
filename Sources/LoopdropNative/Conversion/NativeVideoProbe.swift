@preconcurrency import AVFoundation
import CoreMedia
import Foundation

struct NativeLoadedVideo {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let naturalSize: CGSize
    let preferredTransform: CGAffineTransform
    let metadata: NativeVideoMetadata
}

enum NativeVideoProbeLoader {
    static func validateSource(_ sourceURL: URL) throws {
        var isDirectory = ObjCBool(false)
        let exists = sourceURL.isFileURL
            && FileManager.default.fileExists(atPath: sourceURL.path, isDirectory: &isDirectory)

        guard exists,
              !isDirectory.boolValue,
              FileManager.default.isReadableFile(atPath: sourceURL.path) else {
            throw NativeGIFConversionError.sourceIsNotAReadableFile(sourceURL)
        }
    }

    static func load(_ sourceURL: URL) async throws -> NativeLoadedVideo {
        try validateSource(sourceURL)

        let asset = AVURLAsset(
            url: sourceURL,
            options: [AVURLAssetPreferPreciseDurationAndTimingKey: true]
        )

        do {
            let durationTime = try await asset.load(.duration)
            let tracks = try await asset.loadTracks(withMediaType: .video)

            guard let track = tracks.first else {
                throw NativeGIFConversionError.noVideoTrack(sourceURL)
            }

            let naturalSize = try await track.load(.naturalSize)
            let preferredTransform = try await track.load(.preferredTransform)
            let nominalFrameRate = try await track.load(.nominalFrameRate)
            let formatDescriptions = try await track.load(.formatDescriptions)
            let audioTracks = try await asset.loadTracks(withMediaType: .audio)

            let duration = durationTime.seconds
            guard duration.isFinite, duration > 0 else {
                throw NativeGIFConversionError.invalidAssetDuration(duration)
            }

            let naturalDimensions = NativePixelDimensions(
                width: max(1, Int(abs(naturalSize.width).rounded())),
                height: max(1, Int(abs(naturalSize.height).rounded()))
            )

            let transformedBounds = CGRect(origin: .zero, size: naturalSize)
                .applying(preferredTransform)
                .standardized
            let displayDimensions = NativePixelDimensions(
                width: max(1, Int(abs(transformedBounds.width).rounded())),
                height: max(1, Int(abs(transformedBounds.height).rounded()))
            )

            let frameRate = Double(nominalFrameRate)
            let estimatedFrameCount: Int?
            if frameRate.isFinite, frameRate > 0,
               duration * frameRate < Double(Int.max) {
                estimatedFrameCount = Int((duration * frameRate).rounded())
            } else {
                estimatedFrameCount = nil
            }

            let fileSize = try? sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize
            let metadata = NativeVideoMetadata(
                sourceURL: sourceURL,
                duration: duration,
                naturalDimensions: naturalDimensions,
                displayDimensions: displayDimensions,
                preferredTransform: NativeVideoTransform(preferredTransform),
                orientation: orientation(for: preferredTransform),
                nominalFrameRate: frameRate.isFinite ? frameRate : 0,
                estimatedSourceFrameCount: estimatedFrameCount,
                codec: formatDescriptions.first.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) },
                hasAudio: !audioTracks.isEmpty,
                fileSizeBytes: fileSize.map(Int64.init)
            )

            return NativeLoadedVideo(
                asset: asset,
                track: track,
                naturalSize: naturalSize,
                preferredTransform: preferredTransform,
                metadata: metadata
            )
        } catch let error as NativeGIFConversionError {
            throw error
        } catch is CancellationError {
            throw NativeGIFConversionError.cancelled
        } catch {
            throw NativeGIFConversionError.metadataLoadFailed(
                sourceURL,
                reason: error.localizedDescription
            )
        }
    }

    private static func orientation(for transform: CGAffineTransform) -> NativeVideoOrientation {
        let determinant = (transform.a * transform.d) - (transform.b * transform.c)
        guard determinant >= 0 else { return .other }

        var degrees = atan2(transform.b, transform.a) * 180 / .pi
        if degrees < 0 { degrees += 360 }

        switch degrees {
        case let value where angularDistance(value, 0) < 0.5:
            return .up
        case let value where angularDistance(value, 90) < 0.5:
            return .right
        case let value where angularDistance(value, 180) < 0.5:
            return .down
        case let value where angularDistance(value, 270) < 0.5:
            return .left
        default:
            return .other
        }
    }

    private static func angularDistance(_ lhs: Double, _ rhs: Double) -> Double {
        let difference = abs(lhs - rhs).truncatingRemainder(dividingBy: 360)
        return min(difference, 360 - difference)
    }

    private static func fourCC(_ value: FourCharCode) -> String {
        let bytes: [UInt8] = [
            UInt8((value >> 24) & 0xff),
            UInt8((value >> 16) & 0xff),
            UInt8((value >> 8) & 0xff),
            UInt8(value & 0xff),
        ]

        guard bytes.allSatisfy({ (32...126).contains($0) }) else {
            return String(format: "0x%08X", value)
        }
        return String(bytes: bytes, encoding: .ascii) ?? String(format: "0x%08X", value)
    }
}
