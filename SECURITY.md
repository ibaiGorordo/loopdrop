# Security policy

## Supported versions

Security fixes are provided for the latest published release only.

| Version | Platform | Supported |
| --- | --- | --- |
| 0.2.x | macOS 13+ on Apple silicon and Intel | Yes |
| 0.1.x | Legacy macOS and Linux Electron release | No |

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/ibaiGorordo/loopdrop/security/advisories/new).
Do not open a public issue until a fix or coordinated disclosure is ready.

Include, when possible:

- the affected Loopdrop version, macOS version, and CPU architecture;
- reproduction steps and expected security impact;
- sanitized logs or a minimal synthetic media file; and
- whether you believe the issue is being actively exploited.

Never upload a private video, signing key, certificate, API token, or log that
contains sensitive paths. Wait for a maintainer to agree on a secure transfer
method if a real file is essential.

We aim to acknowledge a complete report within seven days. Investigation and
release timing depend on severity and any disclosure coordination required.

## Security model

- Video probing, decoding, scaling, and GIF encoding run locally through Apple
  AVFoundation, Core Image, and ImageIO.
- Source videos and generated GIFs are never uploaded.
- The application packages no Electron, FFmpeg, JavaScript runtime, telemetry
  SDK, or third-party Swift package.
- Inputs are restricted to local file URLs and formats macOS can decode.
- Conversion uses a 300-frame cap and streams frames instead of retaining an
  entire video in memory.
- Outputs use unique same-directory temporary files and atomic no-replace
  finalization. A racing or existing destination is never overwritten.
- Cancellation and normal application termination wait for owned temporary-file
  cleanup.
- The app contacts only GitHub's public HTTPS Releases API for version checks.
  Update responses are treated as untrusted, release links must remain on
  `https://github.com`, and installation is always a manual user action.
- Official builds come from annotated stable tags reachable from protected
  `main`, are Developer ID signed with hardened runtime, notarized and stapled
  by Apple, checksum-listed, and accompanied by GitHub build provenance.

These guarantees apply to official artifacts attached to releases in this
repository. Builds distributed elsewhere may have been modified.

## Signing-key incidents

If a signing credential or release token may be compromised, report it through
the private channel immediately. Maintainers must suspend releases, revoke or
rotate the credential, review the build chain and published provenance, and
issue a higher signed version only after the incident is understood. Published
release assets and tags must never be silently replaced.
