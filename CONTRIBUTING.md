# Contributing to Loopdrop

Bug reports, focused pull requests, documentation fixes, and reproducible
media-compatibility reports are welcome.

## Before opening an issue

- Search existing issues first.
- Use a synthetic or non-sensitive video whenever a sample is required.
- Include the macOS version, CPU architecture, Loopdrop version or commit,
  input container and codec when known, expected result, and actual result.
- Never upload a private video, signing credential, access token, or complete
  system log containing personal paths.

Report security vulnerabilities privately as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Development setup

Loopdrop requires macOS 13 or later. Apple Command Line Tools are sufficient to
build the application:

```bash
swift build
./scripts/build-app.sh
open ".build/app/loopdrop.app"
```

The XCTest suite requires full Xcode:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift test
```

The Swift package must remain free of external package dependencies. Confirm
that with `swift package show-dependencies`.

## Making a change

1. Keep the change focused and preserve unrelated work.
2. Keep conversion independent of SwiftUI so it can run while the popover is
   closed.
3. Treat file URLs and media metadata as untrusted input.
4. Never silently replace an output. Preserve atomic no-replace finalization
   and cancellation cleanup.
5. Keep frame timing, orientation, collision, and cancellation behavior covered
   by tests.
6. Update public documentation when behavior, compatibility, or distribution
   changes.
7. Run the XCTest suite, strict-concurrency build, and universal app build
   before submitting.

Use Apple frameworks already present in macOS when practical. A proposal to add
a third-party package must explain why the capability cannot reasonably be
implemented with the system SDK, its binary and maintenance cost, and its
license and security implications.

## Pull requests

Describe the user-visible result, validation commands, Mac architectures
tested, and remaining limitations. UI changes should include a capture without
private filenames. Packaging changes must explain signing, notarization, and
license impact.

Pull requests never publish releases. Official artifacts are created only from
reviewed annotated version tags through the protected process documented in
[docs/RELEASING.md](docs/RELEASING.md).

## License

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE). Do not copy third-party code or assets without
explicitly reviewing compatibility and retaining every required notice.
