import Foundation
import XCTest
@testable import LoopdropNative

final class UpdateCheckerTests: XCTestCase {
    func testParsesStableNumericSemanticVersions() throws {
        XCTAssertEqual(NativeSemanticVersion("0.1.0")?.description, "0.1.0")
        XCTAssertEqual(NativeSemanticVersion("v12.34.56")?.description, "12.34.56")
        XCTAssertEqual(NativeSemanticVersion(" V2.0.1\n")?.description, "2.0.1")

        let invalid = [
            "", "1", "1.2", "1.2.3.4", "1.02.3", "01.2.3",
            "1.2.3-beta", "1.2.3+build", "1.-2.3", "１.２.３",
            "18446744073709551616.0.0",
        ]
        for value in invalid {
            XCTAssertNil(NativeSemanticVersion(value), "Unexpectedly accepted \(value)")
        }
    }

    func testComparesEachSemanticVersionComponentNumerically() throws {
        let versions = try ["1.9.99", "1.10.0", "2.0.0"].map { value in
            try XCTUnwrap(NativeSemanticVersion(value))
        }

        XCTAssertLessThan(versions[0], versions[1])
        XCTAssertLessThan(versions[1], versions[2])
        XCTAssertEqual(NativeSemanticVersion("v1.10.0"), versions[1])
        XCTAssertGreaterThan(NativeSemanticVersion("10.0.0")!, NativeSemanticVersion("2.99.99")!)
    }

    func testParsesTrustedGitHubReleasePayload() throws {
        let data = Data("""
        {
            "tag_name": "v1.12.3",
            "html_url": "https://github.com/ibaiGorordo/loopdrop/releases/tag/v1.12.3"
        }
        """.utf8)

        let release = try NativeUpdateReleaseParser.parse(data)
        XCTAssertEqual(release.version, NativeSemanticVersion("1.12.3"))
        XCTAssertEqual(
            release.pageURL.absoluteString,
            "https://github.com/ibaiGorordo/loopdrop/releases/tag/v1.12.3"
        )
    }

    func testRejectsMalformedReleasePayloads() {
        let payloads = [
            Data("not json".utf8),
            Data(#"{"tag_name":"1.2.3"}"#.utf8),
            Data(#"{"tag_name":"1.2.3-beta","html_url":"https://github.com/ibaiGorordo/loopdrop/releases/tag/1.2.3-beta"}"#.utf8),
            Data(#"{"tag_name":"1.2.3","html_url":"https://example.com/release"}"#.utf8),
        ]

        for payload in payloads {
            XCTAssertThrowsError(try NativeUpdateReleaseParser.parse(payload))
        }
    }

    func testReleaseURLTrustBoundary() {
        XCTAssertNotNil(NativeUpdateReleaseParser.trustedReleaseURL(
            "https://github.com/ibaiGorordo/loopdrop/releases/tag/v2.0.0"
        ))
        XCTAssertNotNil(NativeUpdateReleaseParser.trustedReleaseURL(
            "https://github.com:443/ibaiGorordo/loopdrop/releases/tag/v2.0.0"
        ))

        let untrusted = [
            "http://github.com/ibaiGorordo/loopdrop/releases/tag/v2.0.0",
            "https://api.github.com/repos/ibaiGorordo/loopdrop/releases/latest",
            "https://github.com.evil.example/ibaiGorordo/loopdrop/releases/tag/v2.0.0",
            "https://github.com@evil.example/ibaiGorordo/loopdrop/releases/tag/v2.0.0",
            "https://user@github.com/ibaiGorordo/loopdrop/releases/tag/v2.0.0",
            "https://github.com:444/ibaiGorordo/loopdrop/releases/tag/v2.0.0",
            "https://github.com/someone/else/releases/tag/v2.0.0",
            "not a URL",
        ]
        for value in untrusted {
            XCTAssertNil(
                NativeUpdateReleaseParser.trustedReleaseURL(value),
                "Unexpectedly trusted \(value)"
            )
        }
    }
}
