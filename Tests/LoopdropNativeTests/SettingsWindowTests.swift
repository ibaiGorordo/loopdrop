import AppKit
import XCTest
@testable import LoopdropNative

final class SettingsWindowTests: XCTestCase {
    @MainActor
    func testSettingsWindowOpensAndReusesTheSameWindowAfterClosing() throws {
        _ = NSApplication.shared
        let delegate = LoopdropAppDelegate()

        delegate.showSettings()
        let firstWindow = try XCTUnwrap(settingsWindow())
        XCTAssertTrue(firstWindow.isVisible)
        XCTAssertFalse(firstWindow.isReleasedWhenClosed)

        firstWindow.close()
        XCTAssertFalse(firstWindow.isVisible)

        delegate.showSettings()
        let reopenedWindow = try XCTUnwrap(settingsWindow())
        XCTAssertTrue(reopenedWindow === firstWindow)
        XCTAssertTrue(reopenedWindow.isVisible)

        reopenedWindow.orderOut(nil)
    }

    @MainActor
    private func settingsWindow() -> NSWindow? {
        NSApp.windows.first { $0.title == "Loopdrop Settings" }
    }
}
