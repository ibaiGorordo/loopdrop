import AppKit

enum LoopdropMenuBarIcon {
    static let size = NSSize(width: 18, height: 18)

    static func makeImage() -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            NSGraphicsContext.current?.shouldAntialias = true
            NSGraphicsContext.current?.imageInterpolation = .high

            NSColor.black.setFill()

            let ring = NSBezierPath()
            ring.windingRule = .evenOdd
            ring.appendOval(in: rect.insetBy(dx: 2, dy: 2))
            ring.appendOval(in: rect.insetBy(dx: 3.9, dy: 3.9))
            ring.fill()

            NSBezierPath(
                ovalIn: NSRect(x: 11.75, y: 11.6, width: 3.3, height: 3.3)
            ).fill()

            return true
        }
        image.isTemplate = true
        return image
    }
}
