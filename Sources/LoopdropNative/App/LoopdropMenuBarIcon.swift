import AppKit

enum LoopdropMenuBarIcon {
    static let size = NSSize(width: 18, height: 18)
    private static let resourceName = NSImage.Name("LoopdropMenuBarTemplate")

    static func makeImage(bundle: Bundle = .main) -> NSImage {
        if let image = bundle.image(forResource: resourceName) {
            image.size = size
            image.isTemplate = true
            return image
        }

        return makeFallbackImage()
    }

    private static func makeFallbackImage() -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            NSGraphicsContext.current?.shouldAntialias = true

            NSColor.black.setStroke()
            let ring = NSBezierPath(
                ovalIn: rect.insetBy(dx: 1.75, dy: 1.75)
            )
            ring.lineWidth = 2.25
            ring.stroke()

            NSColor.black.setFill()
            NSBezierPath(
                ovalIn: NSRect(x: 11.55, y: 11.25, width: 4.7, height: 4.7)
            ).fill()

            return true
        }
        image.isTemplate = true
        return image
    }
}
