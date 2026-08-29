# Security policy

## Supported versions

loopdrop is currently pre-1.0 software. Security fixes are provided for the
latest published release only.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please report suspected vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/ibaiGorordo/loopdrop/security/advisories/new).
Do not open a public issue until a fix or coordinated disclosure is ready.

Include, when possible:

- the affected loopdrop version and operating system;
- steps to reproduce and the expected security impact;
- logs or a minimal test file with personal information removed; and
- whether you believe the issue is being actively exploited.

Do not upload private or sensitive videos. A synthetic sample that demonstrates
the issue is preferred. If a real file is essential, wait for a maintainer to
agree on a secure transfer method.

We aim to acknowledge a complete report within seven days. Investigation and
release timing depend on severity and the coordination required with upstream
projects.

## Security model

- Video conversion runs locally through a bundled FFmpeg executable.
- Source videos and generated GIFs are not uploaded by loopdrop.
- The Electron renderer is sandboxed and has no direct Node.js access.
- Public desktop releases are built in GitHub Actions from reviewed, stable
  version tags whose commits are reachable from the protected `main` branch.
- macOS releases must be Developer ID signed and notarized.
- Windows releases must be Authenticode signed.
- Release artifacts include SHA-256 checksums and GitHub build provenance.
- Packaged desktop apps contact the public GitHub release service shortly after
  startup to check for updates. Draft releases are not visible to the updater,
  and the official release workflow accepts stable versions only.

These guarantees apply to official artifacts attached to releases in this
repository. Builds provided elsewhere may have been modified.

## Signing-key incidents

If a signing credential or release token may be compromised, report it through
the private channel immediately. Maintainers should revoke the affected
credential, suspend releases and updates, rotate repository secrets, and issue
a new signed release only after the build chain has been reviewed.
