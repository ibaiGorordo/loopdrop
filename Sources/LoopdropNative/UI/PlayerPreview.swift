import AppKit
@preconcurrency import AVFoundation
import SwiftUI

struct PlayerPreview: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> PlayerLayerHostView {
        let view = PlayerLayerHostView()
        view.player = player
        view.setAccessibilityElement(true)
        view.setAccessibilityLabel("Selected video preview")
        return view
    }

    func updateNSView(_ view: PlayerLayerHostView, context: Context) {
        if view.player !== player {
            view.player = player
        }
    }

    static func dismantleNSView(_ view: PlayerLayerHostView, coordinator: Void) {
        view.player = nil
    }
}

final class PlayerLayerHostView: NSView {
    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue }
    }

    private var playerLayer: AVPlayerLayer {
        layer as! AVPlayerLayer
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        playerLayer.videoGravity = .resizeAspectFill
        layerContentsRedrawPolicy = .duringViewResize
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override func makeBackingLayer() -> CALayer {
        AVPlayerLayer()
    }
}
