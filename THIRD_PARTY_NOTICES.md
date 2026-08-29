# Third-party notices

loopdrop is built with open-source software. This notice summarizes the major
runtime components and does not replace the license files shipped with a
release.

## FFmpeg

This software uses code from the FFmpeg project under the LGPL version 2.1 or
later.

- Project: <https://ffmpeg.org/>
- Pinned source release: FFmpeg 9.0.1
- Source: <https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz>
- Signature: <https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz.asc>
- Source SHA-256:
  `cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635`
- License information: <https://ffmpeg.org/legal.html>

loopdrop builds FFmpeg from the signed upstream source without GPL, nonfree, or
version-3-only components. Autodetected external libraries and network
protocols are disabled. Each loopdrop release includes the corresponding FFmpeg
source archive, signature, license texts, source checksum, and build
configuration so that the distributed executable can be audited and rebuilt.

FFmpeg is a separate executable invoked by loopdrop. FFmpeg and its authors do
not endorse loopdrop. Copyright remains with the FFmpeg contributors and other
applicable copyright holders.

## Electron and Chromium

- Electron 44.0.0: MIT License, <https://github.com/electron/electron>
- Chromium and its bundled components: BSD-style and other open-source
  licenses, <https://www.chromium.org/>
- Node.js: MIT License and bundled third-party licenses,
  <https://github.com/nodejs/node>

Every desktop build includes Electron's full MIT license and the exact
`LICENSES.chromium.html` notice extracted from its checksum-verified Electron
release artifact. `LICENSE-MANIFEST.json` records the Electron version,
platform, architecture, upstream artifact checksum, and notice checksums. These
files are in the app's `licenses` resource directory and remain controlling.

## React and React DOM

- React 19.2.6 and React DOM 19.2.6: MIT License,
  <https://github.com/facebook/react>

The full React and React DOM MIT license texts are included separately in each
desktop build's `licenses` resource directory.

## Complete dependency information

Exact JavaScript dependency versions are recorded in `package-lock.json`.
License files embedded in dependencies and packaged runtimes remain controlling
if this summary differs from them.
