import AppKit
import XCTest
@testable import LoopdropNative

final class MenuBarIconTests: XCTestCase {
    func testIconIsACompactTemplateWithTransparentSpace() throws {
        let image = LoopdropMenuBarIcon.makeImage()

        XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
        XCTAssertTrue(image.isTemplate)

        let data = try XCTUnwrap(image.tiffRepresentation)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: data))
        var visiblePixels = 0

        for y in 0 ..< bitmap.pixelsHigh {
            for x in 0 ..< bitmap.pixelsWide {
                if (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.1 {
                    visiblePixels += 1
                }
            }
        }

        XCTAssertGreaterThan(visiblePixels, 0)
        XCTAssertLessThan(visiblePixels, bitmap.pixelsWide * bitmap.pixelsHigh)
    }

    func testSourceArtworkIncludesStandardAndRetinaRepresentations() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let resources = repository.appendingPathComponent("Resources", isDirectory: true)

        let standard = try bitmap(
            at: resources.appendingPathComponent("LoopdropMenuBarTemplate.png")
        )
        let retina = try bitmap(
            at: resources.appendingPathComponent("LoopdropMenuBarTemplate@2x.png")
        )

        XCTAssertEqual(standard.pixelsWide, 18)
        XCTAssertEqual(standard.pixelsHigh, 18)
        XCTAssertEqual(retina.pixelsWide, 36)
        XCTAssertEqual(retina.pixelsHigh, 36)
    }

    private func bitmap(at url: URL) throws -> NSBitmapImageRep {
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(NSBitmapImageRep(data: data))
    }
}
