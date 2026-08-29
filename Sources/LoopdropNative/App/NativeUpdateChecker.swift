import AppKit
import Foundation

struct NativeSemanticVersion: Comparable, CustomStringConvertible, Sendable {
    let major: UInt64
    let minor: UInt64
    let patch: UInt64

    init?(_ value: String) {
        var numeric = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if numeric.first == "v" || numeric.first == "V" {
            numeric.removeFirst()
        }

        let parts = numeric.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }

        func parse(_ part: Substring) -> UInt64? {
            guard !part.isEmpty,
                  !(part.count > 1 && part.first == "0"),
                  part.unicodeScalars.allSatisfy({ (48...57).contains($0.value) }) else {
                return nil
            }
            return UInt64(part)
        }

        guard let major = parse(parts[0]),
              let minor = parse(parts[1]),
              let patch = parse(parts[2]) else {
            return nil
        }
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    var description: String { "\(major).\(minor).\(patch)" }

    static func < (lhs: Self, rhs: Self) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
}

struct NativeUpdateRelease: Equatable, Sendable {
    let version: NativeSemanticVersion
    let pageURL: URL
}

enum NativeUpdateCheckResult: Equatable, Sendable {
    case current(NativeSemanticVersion)
    case updateAvailable(current: NativeSemanticVersion, release: NativeUpdateRelease)
}

enum NativeUpdateError: Error, Equatable, LocalizedError {
    case invalidCurrentVersion
    case invalidServerResponse
    case httpStatus(Int)
    case responseTooLarge
    case invalidReleaseVersion
    case untrustedReleaseURL

    var errorDescription: String? {
        switch self {
        case .invalidCurrentVersion:
            "The installed app version is invalid."
        case .invalidServerResponse:
            "GitHub returned an invalid update response."
        case let .httpStatus(status):
            "GitHub returned HTTP status \(status)."
        case .responseTooLarge:
            "GitHub returned an unexpectedly large update response."
        case .invalidReleaseVersion:
            "The latest GitHub release does not have a stable numeric version."
        case .untrustedReleaseURL:
            "GitHub returned an untrusted release link."
        }
    }
}

enum NativeUpdateReleaseParser {
    private struct Payload: Decodable {
        let tagName: String
        let htmlURL: String

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
        }
    }

    static func parse(_ data: Data) throws -> NativeUpdateRelease {
        let payload: Payload
        do {
            payload = try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw NativeUpdateError.invalidServerResponse
        }

        guard let version = NativeSemanticVersion(payload.tagName) else {
            throw NativeUpdateError.invalidReleaseVersion
        }
        guard let pageURL = trustedReleaseURL(payload.htmlURL) else {
            throw NativeUpdateError.untrustedReleaseURL
        }
        return NativeUpdateRelease(version: version, pageURL: pageURL)
    }

    static func trustedReleaseURL(_ value: String) -> URL? {
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.host?.lowercased() == "github.com",
              components.user == nil,
              components.password == nil,
              components.port == nil || components.port == 443,
              components.path.lowercased().hasPrefix("/ibaigorordo/loopdrop/releases/") else {
            return nil
        }
        return components.url
    }
}

struct NativeUpdateChecker: Sendable {
    static let endpoint = URL(
        string: "https://api.github.com/repos/ibaiGorordo/loopdrop/releases/latest"
    )!

    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpMaximumConnectionsPerHost = 1
        session = URLSession(
            configuration: configuration,
            delegate: NativeUpdateRedirectBlocker(),
            delegateQueue: nil
        )
    }

    func check(currentVersion value: String) async throws -> NativeUpdateCheckResult {
        guard let currentVersion = NativeSemanticVersion(value) else {
            throw NativeUpdateError.invalidCurrentVersion
        }

        var request = URLRequest(
            url: Self.endpoint,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: 15
        )
        request.httpMethod = "GET"
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("Loopdrop/\(currentVersion)", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let response = response as? HTTPURLResponse,
              response.url == Self.endpoint else {
            throw NativeUpdateError.invalidServerResponse
        }
        guard response.statusCode == 200 else {
            throw NativeUpdateError.httpStatus(response.statusCode)
        }
        guard data.count <= 1_048_576 else {
            throw NativeUpdateError.responseTooLarge
        }

        let release = try NativeUpdateReleaseParser.parse(data)
        if release.version > currentVersion {
            return .updateAvailable(current: currentVersion, release: release)
        }
        return .current(currentVersion)
    }
}

private final class NativeUpdateRedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

@MainActor
final class NativeUpdateCoordinator {
    private enum Presentation {
        case available(current: NativeSemanticVersion, release: NativeUpdateRelease, manual: Bool)
        case current(NativeSemanticVersion)
        case failure(String)
    }

    private let checker = NativeUpdateChecker()
    private let currentVersion: String
    private let isConversionActive: @MainActor () -> Bool

    private var periodicTimer: Timer?
    private var deferredTimer: Timer?
    private var startupTask: Task<Void, Never>?
    private var checkTask: Task<Void, Never>?
    private var checkGeneration = 0
    private var deferredPresentation: Presentation?
    private var deferredManualCheck = false
    private var lastAutomaticAlertedVersion: NativeSemanticVersion?

    init(currentVersion: String, isConversionActive: @escaping @MainActor () -> Bool) {
        self.currentVersion = currentVersion
        self.isConversionActive = isConversionActive
    }

    func start() {
        guard periodicTimer == nil else { return }

        let timer = Timer(timeInterval: 6 * 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.runCheck(manual: false)
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        periodicTimer = timer

        startupTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            self?.runCheck(manual: false)
        }
    }

    func stop() {
        startupTask?.cancel()
        checkTask?.cancel()
        periodicTimer?.invalidate()
        deferredTimer?.invalidate()
        startupTask = nil
        checkTask = nil
        periodicTimer = nil
        deferredTimer = nil
        deferredPresentation = nil
        deferredManualCheck = false
    }

    func checkManually() {
        if isConversionActive() {
            deferredManualCheck = true
            scheduleDeferredPresentation()
            return
        }
        runCheck(manual: true)
    }

    private func runCheck(manual: Bool) {
        if !manual, checkTask != nil { return }
        if manual { checkTask?.cancel() }

        checkGeneration &+= 1
        let generation = checkGeneration
        let checker = checker
        let currentVersion = currentVersion

        checkTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.checkGeneration == generation {
                    self.checkTask = nil
                }
            }
            do {
                let result = try await checker.check(currentVersion: currentVersion)
                try Task.checkCancellation()
                guard self.checkGeneration == generation else { return }
                self.handle(result, manual: manual)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, self.checkGeneration == generation, manual else { return }
                self.presentOrDefer(.failure(Self.conciseMessage(for: error)))
            }
        }
    }

    private func handle(_ result: NativeUpdateCheckResult, manual: Bool) {
        switch result {
        case let .current(version):
            if manual { presentOrDefer(.current(version)) }
        case let .updateAvailable(current, release):
            presentOrDefer(.available(current: current, release: release, manual: manual))
        }
    }

    private func presentOrDefer(_ presentation: Presentation) {
        guard isConversionActive() else {
            present(presentation)
            return
        }
        deferredPresentation = presentation
        scheduleDeferredPresentation()
    }

    private func scheduleDeferredPresentation() {
        guard deferredTimer == nil else { return }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.flushDeferredWork()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        deferredTimer = timer
    }

    private func flushDeferredWork() {
        guard !isConversionActive() else { return }
        deferredTimer?.invalidate()
        deferredTimer = nil

        if let deferredPresentation {
            self.deferredPresentation = nil
            deferredManualCheck = false
            present(deferredPresentation)
        } else if deferredManualCheck {
            deferredManualCheck = false
            runCheck(manual: true)
        }
    }

    private func present(_ presentation: Presentation) {
        let alert = NSAlert()
        alert.alertStyle = .informational

        switch presentation {
        case let .available(current, release, manual):
            if !manual, lastAutomaticAlertedVersion == release.version { return }
            if !manual { lastAutomaticAlertedVersion = release.version }
            alert.messageText = "Loopdrop \(release.version) is available"
            alert.informativeText = "You’re running version \(current). Open the GitHub release to download the update."
            alert.addButton(withTitle: "Open Release")
            alert.addButton(withTitle: "Later")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(release.pageURL)
            }

        case let .current(version):
            alert.messageText = "Loopdrop is up to date"
            alert.informativeText = "You’re running the latest version (\(version))."
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()

        case let .failure(message):
            alert.alertStyle = .warning
            alert.messageText = "Couldn’t Check for Updates"
            alert.informativeText = message
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    private static func conciseMessage(for error: Error) -> String {
        let message = (error as NSError).localizedDescription
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? "Try again later." : String(message.prefix(300))
    }
}
