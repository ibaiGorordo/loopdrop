# Changelog

All notable changes to Loopdrop will be documented in this file. The project
uses [Semantic Versioning](https://semver.org/) and follows the structure of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

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
- Cross-platform CI and draft-release automation for macOS, Windows, and Linux.

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
