import AppKit
import XCTest
@testable import LoopdropNative

final class MenuBarIconTests: XCTestCase {
    func testIconIsAResolutionIndependentTemplate() {
        let image = LoopdropMenuBarIcon.makeImage()

        XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
        XCTAssertTrue(image.isTemplate)
        XCTAssertEqual(image.representations.count, 1)
        XCTAssertTrue(image.representations[0] is NSCustomImageRep)
        XCTAssertEqual(image.representations[0].pixelsWide, 0)
        XCTAssertEqual(image.representations[0].pixelsHigh, 0)
    }

    func testVectorMarkRendersWithAntialiasedTransparentEdges() throws {
        let image = LoopdropMenuBarIcon.makeImage()

        let data = try XCTUnwrap(image.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: data))
        var visiblePixels = 0
        var antialiasedPixels = 0

        for y in 0 ..< bitmap.pixelsHigh {
            for x in 0 ..< bitmap.pixelsWide {
                let alpha = bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0
                if alpha > 0.1 {
                    visiblePixels += 1
                }
                if alpha > 0, alpha < 1 {
                    antialiasedPixels += 1
                }
            }
        }

        XCTAssertGreaterThan(visiblePixels, 0)
        XCTAssertLessThan(visiblePixels, bitmap.pixelsWide * bitmap.pixelsHigh)
        XCTAssertGreaterThan(antialiasedPixels, 0)
    }
}
