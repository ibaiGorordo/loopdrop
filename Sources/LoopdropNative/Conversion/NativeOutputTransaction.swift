import Darwin
import Foundation

final class NativeOutputTransaction {
    private(set) var destinationURL: URL
    let temporaryURL: URL

    private let finalDestination: FinalDestination
    private var isActive = true

    private init(destinationURL: URL, finalDestination: FinalDestination) {
        self.destinationURL = destinationURL
        self.finalDestination = finalDestination
        temporaryURL = destinationURL
            .deletingLastPathComponent()
            .appendingPathComponent(
                ".\(destinationURL.lastPathComponent).\(UUID().uuidString).loopdrop-partial",
                isDirectory: false
            )
    }

    static func begin(for destination: NativeGIFDestination, sourceURL: URL) throws -> NativeOutputTransaction {
        switch destination {
        case .downloads:
            guard let downloadsURL = FileManager.default.urls(
                for: .downloadsDirectory,
                in: .userDomainMask
            ).first else {
                throw NativeGIFConversionError.downloadsDirectoryUnavailable
            }

            let rawBaseName = sourceURL.deletingPathExtension().lastPathComponent
            let baseName = rawBaseName.isEmpty ? "Loopdrop" : rawBaseName

            for index in 1...10_000 {
                let candidate = automaticCandidate(
                    directoryURL: downloadsURL,
                    baseName: baseName,
                    index: index
                )
                switch pathStatus(candidate) {
                case .absent:
                    return NativeOutputTransaction(
                        destinationURL: candidate,
                        finalDestination: .automatic(
                            directoryURL: downloadsURL,
                            baseName: baseName,
                            startingIndex: index
                        )
                    )
                case .present:
                    continue
                case let .failed(reason):
                    throw NativeGIFConversionError.outputReservationFailed(candidate, reason: reason)
                }
            }

            let fallbackURL = automaticCandidate(
                directoryURL: downloadsURL,
                baseName: baseName,
                index: 1
            )
            throw NativeGIFConversionError.outputReservationFailed(
                fallbackURL,
                reason: "No collision-free filename was available."
            )

        case let .file(url):
            guard url.isFileURL else {
                throw NativeGIFConversionError.outputReservationFailed(
                    url,
                    reason: "The destination must be a file URL."
                )
            }

            switch pathStatus(url) {
            case .absent:
                return NativeOutputTransaction(
                    destinationURL: url,
                    finalDestination: .exact(url)
                )
            case .present:
                throw NativeGIFConversionError.outputAlreadyExists(url)
            case let .failed(reason):
                throw NativeGIFConversionError.outputReservationFailed(url, reason: reason)
            }
        }
    }

    func commit() throws {
        guard isActive else { return }

        switch finalDestination {
        case let .exact(url):
            switch renameExclusively(from: temporaryURL, to: url) {
            case .renamed:
                destinationURL = url
                isActive = false
                removeImageIOAuxiliaryFiles()
            case .alreadyExists:
                throw NativeGIFConversionError.outputAlreadyExists(url)
            case let .failed(reason):
                throw NativeGIFConversionError.fileFinalizationFailed(url, reason: reason)
            }

        case let .automatic(directoryURL, baseName, startingIndex):
            for index in startingIndex...10_000 {
                let candidate = Self.automaticCandidate(
                    directoryURL: directoryURL,
                    baseName: baseName,
                    index: index
                )
                switch renameExclusively(from: temporaryURL, to: candidate) {
                case .renamed:
                    destinationURL = candidate
                    isActive = false
                    removeImageIOAuxiliaryFiles()
                    return
                case .alreadyExists:
                    continue
                case let .failed(reason):
                    throw NativeGIFConversionError.fileFinalizationFailed(candidate, reason: reason)
                }
            }

            throw NativeGIFConversionError.outputReservationFailed(
                destinationURL,
                reason: "No collision-free filename was available at finalization."
            )
        }
    }

    func cancel() {
        guard isActive else { return }
        try? FileManager.default.removeItem(at: temporaryURL)
        removeImageIOAuxiliaryFiles()
        isActive = false
    }

    deinit {
        cancel()
    }

    private enum FinalDestination {
        case exact(URL)
        case automatic(directoryURL: URL, baseName: String, startingIndex: Int)
    }

    private enum PathStatus {
        case absent
        case present
        case failed(String)
    }

    private enum RenameResult {
        case renamed
        case alreadyExists
        case failed(String)
    }

    private static func automaticCandidate(
        directoryURL: URL,
        baseName: String,
        index: Int
    ) -> URL {
        let suffix = index == 1 ? "" : " \(index)"
        return directoryURL
            .appendingPathComponent("\(baseName)\(suffix)", isDirectory: false)
            .appendingPathExtension("gif")
    }

    private static func pathStatus(_ url: URL) -> PathStatus {
        var capturedErrno: Int32 = 0
        var fileInfo = stat()
        let result = url.withUnsafeFileSystemRepresentation { path -> Int32 in
            guard let path else {
                capturedErrno = EINVAL
                return -1
            }
            let result = Darwin.lstat(path, &fileInfo)
            if result == -1 { capturedErrno = errno }
            return result
        }

        if result == 0 { return .present }
        if capturedErrno == ENOENT { return .absent }
        return .failed(posixErrorDescription(capturedErrno))
    }

    private func renameExclusively(from sourceURL: URL, to destinationURL: URL) -> RenameResult {
        var capturedErrno: Int32 = 0
        let result: Int32 = sourceURL.withUnsafeFileSystemRepresentation { sourcePath in
            destinationURL.withUnsafeFileSystemRepresentation { destinationPath -> Int32 in
                guard let sourcePath, let destinationPath else {
                    capturedErrno = EINVAL
                    return -1
                }
                let result = Darwin.renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
                if result == -1 { capturedErrno = errno }
                return result
            }
        }

        if result == 0 { return .renamed }
        if capturedErrno == EEXIST { return .alreadyExists }
        return .failed(Self.posixErrorDescription(capturedErrno))
    }

    private func removeImageIOAuxiliaryFiles() {
        // CGImageDestination writes through its own hidden sibling before it is
        // finalized. On cancellation that file can outlive the destination object,
        // so remove only siblings carrying this transaction's UUID-based prefix.
        let directoryURL = temporaryURL.deletingLastPathComponent()
        let imageIOPrefix = ".\(temporaryURL.lastPathComponent)-"
        if let siblings = try? FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsSubdirectoryDescendants]
        ) {
            for sibling in siblings where sibling.lastPathComponent.hasPrefix(imageIOPrefix) {
                try? FileManager.default.removeItem(at: sibling)
            }
        }
    }

    private static func posixErrorDescription(_ code: Int32) -> String {
        guard let message = strerror(code) else { return "POSIX error \(code)" }
        return String(cString: message)
    }
}
