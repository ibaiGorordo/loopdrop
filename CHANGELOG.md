# Changelog

All notable changes to Loopdrop will be documented in this file. The project
uses [Semantic Versioning](https://semver.org/) and follows the structure of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- The macOS status item now uses a smooth, resolution-independent version of
  Loopdrop's loop-and-drop mark instead of the generic `film.stack` symbol.
- Settings now opens reliably from both the mini converter and its context
  menu in the menu-bar-only application.

## [0.2.0] - 2026-08-30

### Changed

- Rebuilt Loopdrop as a native macOS 13+ menu-bar application using SwiftUI,
  AppKit, AVFoundation, Core Image, and ImageIO.
- Reduced the universal Apple silicon and Intel application from hundreds of
  megabytes to approximately 2 MB with no packaged third-party dependencies.
- Replaced the full editor with a focused 410 × 176 converter containing only
  clip, quality, preview, clear, progress, cancel, and create controls.
- Full-video conversions now preserve duration by adapting the frame rate to
  the 300-frame limit and report the effective rate.
- Update checks now use Apple's networking stack and open the signed GitHub
  release page for manual installation instead of silently replacing the app.

### Added

- Native background conversion protected from App Nap when the popover closes.
- A lightweight, resolution-bounded video preview that releases decoding state
  whenever the popover is hidden.
- Universal arm64 and x86_64 builds with an explicit macOS 13 deployment target.
- Native tests for orientation, every-frame GIF timing and dimensions, changing
  frame content, frame limits, cancellation cleanup, and output races.

### Removed

- Electron, Chromium, Node.js, React, FFmpeg, FFprobe, and all npm dependencies.
- Linux and prospective Windows packages, the full desktop editor, CLI, MCP
  server, automatic self-updater, and their platform-specific build pipelines.
- Runtime third-party notices; v0.1.0 remains immutable with the notices and
  source required by its legacy Electron/FFmpeg artifacts.

### Security

- Output finalization uses an atomic no-replace operation, so a destination
  created during conversion is never overwritten or deleted.
- Quitting during conversion waits for cancellation and temporary-file cleanup.
- Official packages contain the project MIT license, use hardened-runtime
  Developer ID signing, and are notarized and stapled by Apple.

## [0.1.0] - 2026-08-29

### Added

- Public desktop packages for signed and notarized universal macOS plus Linux
  x64 and arm64 with a glibc 2.35 baseline. Windows distribution is deferred
  pending Authenticode signing and release validation.
- Full Electron video-to-GIF editor with local preview, trim, size, frame-rate,
  palette, and loop controls.
- Compact menu-bar and system-tray converter with drag and drop, clip and
  quality presets, automatic Downloads output, and a clear-video action.
- Native application Settings menu and locally persisted conversion defaults.
- Shared FFmpeg conversion core with correct GIF timing, progress,
  cancellation, frame limits, accurate-seek fallback, and atomic outputs.
- Scriptable CLI with inspect, convert, JSON, and structured progress modes.
- Local stdio MCP server with `inspect_video` and `convert_video_to_gif` tools.
- Pinned LGPL-compatible FFmpeg build scripts and third-party notices.
- Checksum-verified packaged Electron, Chromium, React, and application license
  manifests.
- Cross-platform CI plus draft-release automation for signed and notarized
  macOS packages and Linux x64/arm64 packages.
- Manual and periodic signed-update checks on macOS, with conversion-safe
  restart deferral and verified release metadata; Linux links to GitHub
  Releases for package updates.

### Fixed

- Legacy formats that FFmpeg supports can still be converted when Chromium
  cannot render their in-app preview.
- Forced CLI output refuses directories and other non-regular filesystem
  targets without moving or replacing them.

### Security

- Sandboxed Electron renderers with context isolation and a narrow preload API.
- Production renderer content security policy blocks arbitrary network
  connections.
- Release checks for signing, notarization, FFmpeg configuration, checksums,
  and build provenance.

[Unreleased]: https://github.com/ibaiGorordo/loopdrop/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ibaiGorordo/loopdrop/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ibaiGorordo/loopdrop/releases/tag/v0.1.0
