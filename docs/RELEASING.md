# Releasing loopdrop

Official releases are built from version tags by
`.github/workflows/release.yml`. The workflow builds the bundled FFmpeg from
verified upstream source, creates native installers, signs supported platforms,
and opens a draft GitHub release for final human review.

## Release outputs

| Platform | Architecture | Artifacts |
| --- | --- | --- |
| macOS 13 or later | Universal, arm64 + x64 | DMG and ZIP |
| Windows | x64 | NSIS installer |
| Linux | x64 and arm64 | AppImage and deb |

The macOS ZIP is required by the updater even though the DMG is the normal
manual download. Update manifests, applicable blockmaps, FFmpeg compliance files,
`SHA256SUMS`, and GitHub provenance attestations are published with the
installers. Every packaged app also contains a licenses directory under its
resources path (`Contents/Resources/licenses` on macOS) with the Loopdrop,
Electron, Chromium, React, React DOM, and third-party notices plus a
SHA-256-backed `LICENSE-MANIFEST.json`; release jobs verify its exact file set and
hashes before uploading anything.

## One-time repository setup

1. Create the public `ibaiGorordo/loopdrop` repository and push the default
   branch.
2. Set the default `GITHUB_TOKEN` permission to read-only. Allow the workflow's
   explicit release-job permissions for GitHub Releases, OIDC, artifact
   attestations, and artifact metadata.
3. In repository settings, create an environment named `release` **before any
   release tag is pushed**.
4. Add a required reviewer to that environment, prevent self-review if another
   reviewer is available, and restrict deployment tags to `v*.*.*`.
5. Create branch and tag rulesets. Require pull requests, CODEOWNER review, and
   all `Source checks (…)` jobs plus `LGPL FFmpeg integration` on `main`.
   Restrict creation, update, and deletion of tags matching `v*.*.*` to the
   release maintainer.
6. Enable private vulnerability reporting, Dependabot alerts, and Dependabot
   security updates. The checked-in Dependabot configuration also proposes
   routine dependency and SHA-pinned action updates.
7. Add the signing secrets listed below as **environment secrets**. Do not
   create repository or organization secrets with the same names.

Keep pull-request CI unsigned and secret-free. Signing commands fail closed if
any required secret is absent, and their jobs use the protected `release`
environment. Repository settings provide the required human gate; the workflow
cannot create that protection itself.

## macOS enrollment and secrets

Public distribution outside the Mac App Store requires paid Apple Developer
Program membership, a Developer ID Application certificate, hardened runtime,
and notarization. A Developer ID Installer certificate is not needed for the
DMG and ZIP produced here.

After enrollment:

1. As the Apple team Account Holder, create a **Developer ID Application**
   certificate.
2. Install it with its private key in Keychain Access.
3. Export the identity and private key as a password-protected `.p12` file.
4. Base64-encode the `.p12` and store it as `MAC_CSC_LINK`.
5. Store its export password as `MAC_CSC_KEY_PASSWORD`.
6. In App Store Connect, create a **Team API key** with App Manager access for
   notarization. Do not use an Individual API key: this workflow and
   electron-builder configuration require the Team key's issuer ID.
7. Download the Team key's `.p8` file once, base64-encode it, and store it as
   `APPLE_API_KEY_B64`. Add its key ID and issuer ID as the remaining secrets.

| Environment secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_B64` | Base64-encoded App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | Ten-character Team API key ID |
| `APPLE_API_ISSUER` | Team API key issuer UUID |

electron-builder 26 expects `APPLE_API_KEY` to be a file path. The workflow
decodes `APPLE_API_KEY_B64` only inside the signing step, validates its format,
and deletes the temporary runner file when that step exits. It is never written
to the repository or an artifact.

## Windows signing secrets

The Windows installer and packaged executables must be signed by a publicly
trusted Authenticode identity. electron-builder signs `.exe` files copied as
extra resources, and the release job fails unless the installer, main app,
bundled `ffmpeg.exe`, and bundled `ffprobe.exe` all report valid Authenticode
signatures.

| Environment secret | Value |
| --- | --- |
| `WIN_CSC_LINK` | Base64-encoded OV/EV `.pfx` or a secure certificate URL supported by electron-builder |
| `WIN_CSC_KEY_PASSWORD` | Certificate/private-key password |

Many current certificate authorities issue private keys through hardware or a
managed signing service rather than an exportable `.pfx`. In that case, replace
the PFX environment integration with the provider-specific electron-builder
signing hook while preserving the signature-verification step.

[Microsoft Artifact Signing Public Trust](https://learn.microsoft.com/azure/artifact-signing/quickstart)
is available to Japanese organizations, but Microsoft currently limits
individual developer enrollment to the United States and Canada. A Japan-based
individual therefore needs a certificate from a compatible public CA or must
release Windows builds later after establishing an eligible organization.

Never publish an unsigned Windows installer as an official production release.

## FFmpeg compliance build

loopdrop does not use the `ffmpeg-static` npm binary. Every release builds the
pinned FFmpeg source with GPL, nonfree, version-3-only, external autodetected,
and network components disabled. The release workflow rejects a forbidden build
configuration and performs a real palette-based GIF conversion.

The pinned source is:

```text
FFmpeg 9.0.1
https://ffmpeg.org/releases/ffmpeg-9.0.1.tar.xz
SHA-256 cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635
```

When changing FFmpeg:

1. Download the release and detached signature from `ffmpeg.org`.
2. Verify the release-signing key fingerprint and signature.
3. Update the version and pinned checksum in both FFmpeg build scripts, the
   workflow, and `THIRD_PARTY_NOTICES.md`.
4. Inspect `ffmpeg -buildconf` on every architecture.
5. Run unit and packaged smoke tests on every runner.
6. Attach the exact source archive, signature, license texts, checksum, and
   configuration to the release.

The repository documentation is engineering guidance, not legal advice. Review
license and patent obligations before distributing in a new jurisdiction.

## npm publication is separate

Neither CI nor the desktop release workflow runs `npm publish`, and no npm token
is required for either workflow. CI only runs `npm pack --dry-run` to inspect the
prospective package. Keep the first npm publication as a separate, deliberate
manual process after verifying package ownership, contents, provenance, CLI and
MCP behavior, and npm account two-factor authentication. Do not add an
`NPM_TOKEN` to the repository in preparation for a desktop release.

## Creating a release

1. Update `version` in `package.json` and `package-lock.json` using a stable
   `MAJOR.MINOR.PATCH` version. This workflow deliberately rejects prerelease
   suffixes, build metadata, mismatched lockfile versions, and a non-MIT package
   license.
2. Update user-facing release notes or the changelog.
3. From a clean checkout, run:

   ```bash
   npm ci
   scripts/build-ffmpeg-unix.sh vendor/ffmpeg/current
   npm test
   npm run build
   ```

4. Commit and merge the release changes to the protected `main` branch.
5. Create and push the matching annotated tag. The workflow deliberately fails
   if the tag and package version differ.

   ```bash
   version="$(node -p "require('./package.json').version")"
   git tag -a "v${version}" -m "loopdrop ${version}"
   git push origin "v${version}"
   ```

6. Approve the protected `release` environment deployment request or requests
   after reviewing the tagged commit.
7. Wait for all architecture builds, signing checks, smoke tests, checksums, and
   attestations to pass.

The tag must be annotated, must match the package version exactly, and must point
to a commit reachable from `origin/main`. The workflow creates a **draft**
release. It does not publish npm packages and does not automatically expose a
new desktop version to users or the automatic updater.

## Reviewing the draft

Before publishing, use clean virtual machines or physical test devices and
check all of the following:

- the tag, package version, filenames, and release notes agree;
- the macOS DMG opens and the app runs on both Apple Silicon and Intel;
- Gatekeeper identifies the expected Developer ID publisher;
- `codesign --verify --deep --strict` and `spctl --assess` pass;
- the notarization ticket validates without relying on the build machine;
- the Windows installer shows the expected publisher and installs/uninstalls;
- the Windows installer and Loopdrop application executable have valid
  Authenticode signatures, as do the bundled FFmpeg and FFprobe executables;
- x64 and arm64 AppImages launch on representative Linux distributions;
- both deb packages install, launch, and uninstall cleanly;
- a real local video converts to a correctly timed GIF on each platform;
- update manifests and their referenced artifacts are present together;
- the packaged `LICENSE-MANIFEST.json` under the app's resources/licenses path
  and every notice it references are present;
- `SHA256SUMS` verifies; and
- GitHub verifies the artifact attestation for representative installers.

Example checksum and attestation verification:

```bash
sha256sum --check SHA256SUMS
gh attestation verify loopdrop-VERSION-mac-universal.dmg \
  --repo ibaiGorordo/loopdrop
```

Once QA passes, edit the draft release on GitHub and publish it. Stable updater
clients can see the release only after this step.

## Failed or compromised releases

- For a transient infrastructure failure, rerun the same tagged workflow. If an
  existing draft contains an unexpected stale asset, remove that asset manually
  before rerunning.
- If source or dependencies must change, delete the draft, increment the
  version, merge a new commit, and create a new tag. Never move or reuse a
  release tag.
- Do not silently replace artifacts in a published release.
- If a published build is broken, publish a higher patch version. Update clients
  cannot recover from a bad release by reusing the same version number.
- For a suspected signing-key or workflow compromise, keep the release draft,
  revoke or rotate the affected credentials, review the build provenance, and
  follow `SECURITY.md` before publishing again.
