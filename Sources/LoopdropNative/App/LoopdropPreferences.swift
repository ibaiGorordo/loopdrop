import SwiftUI

enum ClipLengthPreset: String, CaseIterable, Identifiable {
    case threeSeconds = "3"
    case fiveSeconds = "5"
    case tenSeconds = "10"
    case full

    var id: String { rawValue }

    var title: String {
        switch self {
        case .threeSeconds: "3s"
        case .fiveSeconds: "5s"
        case .tenSeconds: "10s"
        case .full: "Full"
        }
    }

    var seconds: Double? {
        switch self {
        case .threeSeconds: 3
        case .fiveSeconds: 5
        case .tenSeconds: 10
        case .full: nil
        }
    }
}

enum QualityPreset: String, CaseIterable, Identifiable {
    case compact
    case balanced
    case hd

    var id: String { rawValue }

    var title: String {
        switch self {
        case .compact: "Compact"
        case .balanced: "Balanced"
        case .hd: "HD"
        }
    }

    var detail: String {
        switch self {
        case .compact: "480 px · 10 fps"
        case .balanced: "720 px · 15 fps"
        case .hd: "1080 px · 20 fps"
        }
    }

    var maximumDimension: Int {
        switch self {
        case .compact: 480
        case .balanced: 720
        case .hd: 1_080
        }
    }

    var framesPerSecond: Double {
        switch self {
        case .compact: 10
        case .balanced: 15
        case .hd: 20
        }
    }
}

@MainActor
final class LoopdropPreferences: ObservableObject {
    private enum Key {
        static let clipLength = "native.defaultClipLength"
        static let quality = "native.defaultQuality"
        static let revealOutput = "native.revealOutput"
        static let playPreview = "native.playPreview"
    }

    private let defaults: UserDefaults

    @Published var clipLength: ClipLengthPreset {
        didSet { defaults.set(clipLength.rawValue, forKey: Key.clipLength) }
    }

    @Published var quality: QualityPreset {
        didSet { defaults.set(quality.rawValue, forKey: Key.quality) }
    }

    @Published var revealOutput: Bool {
        didSet { defaults.set(revealOutput, forKey: Key.revealOutput) }
    }

    @Published var playPreview: Bool {
        didSet { defaults.set(playPreview, forKey: Key.playPreview) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        clipLength = defaults.string(forKey: Key.clipLength)
            .flatMap(ClipLengthPreset.init(rawValue:)) ?? .fiveSeconds
        quality = defaults.string(forKey: Key.quality)
            .flatMap(QualityPreset.init(rawValue:)) ?? .balanced
        revealOutput = defaults.object(forKey: Key.revealOutput) as? Bool ?? true
        playPreview = defaults.object(forKey: Key.playPreview) as? Bool ?? true
    }

    func restoreDefaults() {
        clipLength = .fiveSeconds
        quality = .balanced
        revealOutput = true
        playPreview = true
    }
}
