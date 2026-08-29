import CoreGraphics
import Foundation

public protocol NativeGIFConverting: Sendable {
    func probe(_ sourceURL: URL) async throws -> NativeVideoMetadata

    func convert(
        _ request: NativeGIFConversionRequest,
        progress: @escaping NativeGIFProgressHandler
    ) async throws -> NativeGIFConversionResult
}

public extension NativeGIFConverting {
    func convert(_ request: NativeGIFConversionRequest) async throws -> NativeGIFConversionResult {
        try await convert(request, progress: { _ in })
    }
}

public typealias NativeGIFProgressHandler = @MainActor @Sendable (NativeGIFProgress) -> Void

public struct NativeGIFConversionRequest: Sendable, Equatable {
    public var sourceURL: URL
    public var startTime: TimeInterval
    public var duration: TimeInterval?
    public var framesPerSecond: Double
    public var maximumDimension: NativeGIFMaximumDimension
    public var loopCount: Int
    public var destination: NativeGIFDestination

    public init(
        sourceURL: URL,
        startTime: TimeInterval = 0,
        duration: TimeInterval? = nil,
        framesPerSecond: Double = 12,
        maximumDimension: NativeGIFMaximumDimension = .medium,
        loopCount: Int = 0,
        destination: NativeGIFDestination = .downloads
    ) {
        self.sourceURL = sourceURL
        self.startTime = startTime
        self.duration = duration
        self.framesPerSecond = framesPerSecond
        self.maximumDimension = maximumDimension
        self.loopCount = loopCount
        self.destination = destination
    }
}

public enum NativeGIFMaximumDimension: Sendable, Equatable {
    case original
    case pixels(Int)

    public static var small: Self { .pixels(320) }
    public static var medium: Self { .pixels(480) }
    public static var large: Self { .pixels(720) }

    public var pixels: Int? {
        switch self {
        case .original:
            nil
        case let .pixels(value):
            value
        }
    }
}

public enum NativeGIFDestination: Sendable, Equatable {
    /// Writes to Downloads and atomically reserves a collision-free filename.
    case downloads

    /// Writes to an exact file URL and fails rather than replacing an existing item.
    case file(URL)
}

public struct NativeGIFConversionResult: Sendable, Equatable {
    public let sourceURL: URL
    public let outputURL: URL
    public let metadata: NativeVideoMetadata
    public let frameCount: Int
    public let sourceDuration: TimeInterval
    public let outputDimensions: NativePixelDimensions
    public let fileSizeBytes: Int64

    public init(
        sourceURL: URL,
        outputURL: URL,
        metadata: NativeVideoMetadata,
        frameCount: Int,
        sourceDuration: TimeInterval,
        outputDimensions: NativePixelDimensions,
        fileSizeBytes: Int64
    ) {
        self.sourceURL = sourceURL
        self.outputURL = outputURL
        self.metadata = metadata
        self.frameCount = frameCount
        self.sourceDuration = sourceDuration
        self.outputDimensions = outputDimensions
        self.fileSizeBytes = fileSizeBytes
    }
}

public struct NativeVideoMetadata: Sendable, Equatable {
    public let sourceURL: URL
    public let duration: TimeInterval
    public let naturalDimensions: NativePixelDimensions
    public let displayDimensions: NativePixelDimensions
    public let preferredTransform: NativeVideoTransform
    public let orientation: NativeVideoOrientation
    public let nominalFrameRate: Double
    public let estimatedSourceFrameCount: Int?
    public let codec: String?
    public let hasAudio: Bool
    public let fileSizeBytes: Int64?

    public init(
        sourceURL: URL,
        duration: TimeInterval,
        naturalDimensions: NativePixelDimensions,
        displayDimensions: NativePixelDimensions,
        preferredTransform: NativeVideoTransform,
        orientation: NativeVideoOrientation,
        nominalFrameRate: Double,
        estimatedSourceFrameCount: Int?,
        codec: String?,
        hasAudio: Bool,
        fileSizeBytes: Int64?
    ) {
        self.sourceURL = sourceURL
        self.duration = duration
        self.naturalDimensions = naturalDimensions
        self.displayDimensions = displayDimensions
        self.preferredTransform = preferredTransform
        self.orientation = orientation
        self.nominalFrameRate = nominalFrameRate
        self.estimatedSourceFrameCount = estimatedSourceFrameCount
        self.codec = codec
        self.hasAudio = hasAudio
        self.fileSizeBytes = fileSizeBytes
    }
}

public struct NativePixelDimensions: Sendable, Equatable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public var maximum: Int { max(width, height) }
    public var isPortrait: Bool { height > width }
}

public struct NativeVideoTransform: Sendable, Equatable {
    public let a: Double
    public let b: Double
    public let c: Double
    public let d: Double
    public let tx: Double
    public let ty: Double

    public init(a: Double, b: Double, c: Double, d: Double, tx: Double, ty: Double) {
        self.a = a
        self.b = b
        self.c = c
        self.d = d
        self.tx = tx
        self.ty = ty
    }

    init(_ transform: CGAffineTransform) {
        self.init(
            a: transform.a,
            b: transform.b,
            c: transform.c,
            d: transform.d,
            tx: transform.tx,
            ty: transform.ty
        )
    }
}

public enum NativeVideoOrientation: String, Sendable, Equatable, CaseIterable {
    case up
    case right
    case down
    case left
    case other
}

public struct NativeGIFProgress: Sendable, Equatable {
    public let stage: NativeGIFConversionStage
    public let fractionCompleted: Double
    public let completedFrames: Int
    public let totalFrames: Int

    public init(
        stage: NativeGIFConversionStage,
        fractionCompleted: Double,
        completedFrames: Int,
        totalFrames: Int
    ) {
        self.stage = stage
        self.fractionCompleted = min(max(fractionCompleted, 0), 1)
        self.completedFrames = completedFrames
        self.totalFrames = totalFrames
    }
}

public enum NativeGIFConversionStage: String, Sendable, Equatable {
    case preparing
    case decoding
    case finalizing
    case completed
}

public enum NativeGIFConversionError: Error, LocalizedError, Sendable, Equatable {
    case sourceIsNotAReadableFile(URL)
    case metadataLoadFailed(URL, reason: String)
    case noVideoTrack(URL)
    case invalidAssetDuration(TimeInterval)
    case invalidStartTime(TimeInterval)
    case invalidDuration(TimeInterval)
    case invalidFrameRate(Double)
    case invalidMaximumDimension(Int)
    case invalidLoopCount(Int)
    case frameLimitExceeded(requested: Int, maximum: Int)
    case gifFrameDelayLimitExceeded
    case downloadsDirectoryUnavailable
    case outputAlreadyExists(URL)
    case outputReservationFailed(URL, reason: String)
    case readerCreationFailed(reason: String)
    case readerConfigurationFailed
    case readerFailed(reason: String)
    case frameRenderingFailed
    case destinationCreationFailed(URL)
    case destinationFinalizationFailed(URL)
    case noFramesDecoded
    case fileFinalizationFailed(URL, reason: String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case let .sourceIsNotAReadableFile(url):
            "The selected source is not a readable file: \(url.lastPathComponent)."
        case let .metadataLoadFailed(url, reason):
            "Could not read video metadata for \(url.lastPathComponent): \(reason)"
        case let .noVideoTrack(url):
            "No supported video track was found in \(url.lastPathComponent)."
        case let .invalidAssetDuration(duration):
            "The source has an invalid duration (\(duration) seconds)."
        case let .invalidStartTime(startTime):
            "The start time must be within the source video (received \(startTime) seconds)."
        case let .invalidDuration(duration):
            "The conversion duration must be greater than zero (received \(duration) seconds)."
        case let .invalidFrameRate(frameRate):
            "The frame rate must be a finite number greater than zero (received \(frameRate))."
        case let .invalidMaximumDimension(dimension):
            "The maximum dimension must be greater than zero (received \(dimension) pixels)."
        case let .invalidLoopCount(loopCount):
            "The GIF loop count cannot be negative (received \(loopCount))."
        case let .frameLimitExceeded(requested, maximum):
            "These settings require \(requested) frames; the maximum is \(maximum)."
        case .gifFrameDelayLimitExceeded:
            "The selected duration is too long for reliable GIF frame timing."
        case .downloadsDirectoryUnavailable:
            "The Downloads folder could not be located."
        case let .outputAlreadyExists(url):
            "A file already exists at \(url.path)."
        case let .outputReservationFailed(url, reason):
            "Could not reserve \(url.lastPathComponent): \(reason)"
        case let .readerCreationFailed(reason):
            "Could not create the video reader: \(reason)"
        case .readerConfigurationFailed:
            "The video reader could not decode the selected video track."
        case let .readerFailed(reason):
            "Video decoding failed: \(reason)"
        case .frameRenderingFailed:
            "A decoded video frame could not be rendered."
        case let .destinationCreationFailed(url):
            "Could not create a GIF at \(url.lastPathComponent)."
        case let .destinationFinalizationFailed(url):
            "ImageIO could not finalize \(url.lastPathComponent)."
        case .noFramesDecoded:
            "No video frames were decoded in the selected time range."
        case let .fileFinalizationFailed(url, reason):
            "Could not atomically finalize \(url.lastPathComponent): \(reason)"
        case .cancelled:
            "Conversion was cancelled."
        }
    }
}
