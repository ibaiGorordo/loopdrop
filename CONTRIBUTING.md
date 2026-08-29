# Contributing to Loopdrop

Thank you for helping improve Loopdrop. Bug reports, focused pull requests,
platform testing, documentation fixes, and reproducible media-compatibility
reports are welcome.

## Before opening an issue

- Search existing issues first.
- Use a synthetic or non-sensitive video whenever a sample is required.
- Include the operating system, CPU architecture, Loopdrop commit or version,
  input container/codec when known, expected result, and actual result.
- Never upload a private video, signing credential, access token, or complete
  system log containing personal paths.

Security vulnerabilities belong in the private reporting channel described in
[SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Loopdrop requires Node.js 22.13 or newer. From a source checkout:

```bash
npm ci
npm run ffmpeg:build
npm run dev
```

`npm run ffmpeg:build` builds the pinned FFmpeg release on macOS or Linux. You
may instead set `LOOPDROP_FFMPEG_PATH` and `LOOPDROP_FFPROBE_PATH` to compatible
local binaries. Windows FFmpeg release builds use the PowerShell/MSYS2 script
documented in [docs/RELEASING.md](docs/RELEASING.md).

## Making a change

1. Keep the change focused and preserve unrelated work.
2. Reuse `core/converter.cjs` for conversion behavior shared by the desktop,
   CLI, and MCP interfaces.
3. Keep renderer code sandbox-compatible; do not enable Node.js integration or
   expose general filesystem/process access through the preload bridge.
4. Add or update tests for behavior changes.
5. Update `README.md`, `CHANGELOG.md`, or release documentation when the public
   interface or distribution process changes.
6. Run the complete local check before submitting:

   ```bash
   npm run check
   ```

The test suite uses Node's built-in test runner and covers the core, CLI, MCP
server, and a real FFmpeg timing/cancellation path when a compatible binary is
available.

## Code conventions

- Match the existing TypeScript, ESM, or CommonJS style of the file being
  changed.
- Prefer small, explicit interfaces between processes.
- Treat local paths and media metadata as untrusted input.
- Do not silently overwrite outputs. Preserve atomic finalization and cleanup
  of temporary files.
- Keep stdout machine-readable in JSON CLI mode and reserve MCP stdout for the
  protocol; diagnostics belong on stderr.
- Avoid adding a network dependency to the conversion path.

## Pull requests

Describe the user-visible outcome, test commands and results, platforms tested,
and any remaining limitations. UI changes should include a screenshot without
private filenames. Packaging changes should explain their signing and
third-party-license impact.

Pull requests do not publish a release. Official artifacts are produced only
from reviewed version tags through the protected release process in
[docs/RELEASING.md](docs/RELEASING.md).

## License

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE). Third-party code or assets must have a
compatible license and retain any required attribution.
