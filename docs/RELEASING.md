# Releasing Loopdrop

Official releases are produced by [the protected release workflow](../.github/workflows/release.yml)
from annotated stable tags. The workflow builds one universal native macOS app,
signs it with hardened runtime, notarizes and staples it, verifies Gatekeeper,
and creates a draft GitHub release for final human QA.

Published releases are immutable. Never move a tag or replace an asset after a
release becomes public. The legacy v0.1.0 release and all of its FFmpeg source,
license, and Linux/Electron artifacts must remain unchanged.

## Outputs

A native release has exactly four explicit assets:

| File | Purpose |
| --- | --- |
| `loopdrop-VERSION-mac-universal.dmg` | Normal drag-to-Applications installer |
| `loopdrop-VERSION-mac-universal.zip` | Stapled app archive and v0.1 updater transition payload |
| `latest-mac.yml` | Compatibility metadata for the v0.1 Electron updater |
| `SHA256SUMS` | SHA-256 checksums for the other three files |

GitHub adds source archives automatically. Native releases contain no Linux or
Windows package, blockmap, FFmpeg source, third-party notice, npm package, CLI,
or MCP artifact. The app bundle includes the root MIT license at
`Contents/Resources/LICENSE`.

## Repository protection

- The default `GITHUB_TOKEN` permission is read-only.
- `main` requires the native macOS CI checks.
- Tags matching `v*.*.*` are protected.
- The `release` environment requires a reviewer and permits only matching
  version tags.
- Signing secrets exist only in that protected environment.
- Workflow actions are pinned to full commit SHAs.

Pull-request CI is unsigned and never receives release secrets.

## Apple credentials

Public distribution outside the Mac App Store requires an active Apple
Developer Program membership, a **Developer ID Application** certificate, and
an App Store Connect **Team API key** accepted by `notarytool`.

The protected `release` environment contains:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded password-protected Developer ID Application P12 |
| `MAC_CSC_KEY_PASSWORD` | P12 export password |
| `APPLE_API_KEY_B64` | Base64-encoded App Store Connect Team API P8 |
| `APPLE_API_KEY_ID` | API key ID |
| `APPLE_API_ISSUER` | API issuer UUID |

The workflow decodes credentials only beneath `RUNNER_TEMP`, imports the P12
into an isolated temporary keychain, requires the expected Developer ID team,
and deletes the temporary keychain and files when packaging ends. Never put
these values in repository secrets, source, logs, artifacts, or release notes.

## Prepare a version

1. Set `CFBundleShortVersionString` in
   [Resources/Info.plist](../Resources/Info.plist) to a stable
   `MAJOR.MINOR.PATCH` value. This is the tracked release-version source.
2. Increase `CFBundleVersion` monotonically.
3. Update [CHANGELOG.md](../CHANGELOG.md), installation text, compatibility
   notes, and any user-visible behavior.
4. From a clean checkout, run:

   ```bash
   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
     xcrun swift test

   DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
     xcrun swift build \
       -Xswiftc -warnings-as-errors \
       -Xswiftc -strict-concurrency=complete

   ./scripts/build-app.sh
   swift package show-dependencies
   ```

5. Confirm the dependency graph is empty, the app has exactly arm64 and x86_64
   slices, each slice targets macOS 13.0, `codesign --verify --deep --strict`
   passes, the bundled license matches the root license, and linked libraries
   come only from `/System/Library` or `/usr/lib`.
6. Commit and push the reviewed change to protected `main`. Wait for native CI
   to pass.
7. Create and push a matching annotated tag:

   ```bash
   version="$(plutil -extract CFBundleShortVersionString raw Resources/Info.plist)"
   git tag -a "v${version}" -m "Loopdrop ${version}"
   git push origin "v${version}"
   ```

The workflow rejects prerelease/build suffixes, a tag/version mismatch, a
lightweight tag, a tag not pointing at the checked-out commit, or a tag whose
commit is not reachable from `origin/main`.

## Packaging and notarization

The release job:

1. Builds explicit arm64 and x86_64 slices at macOS 13.0 and combines them.
2. Signs `loopdrop.app` using `codesign --options runtime --timestamp`.
3. Verifies the designated requirement, authority, team, hardened-runtime flag,
   architecture set, deployment target, metadata, license, dependency allowlist,
   and size ceiling.
4. Submits a temporary ZIP to `notarytool`, requires `Accepted`, staples the
   app, and validates the ticket and Gatekeeper assessment.
5. Creates the final ZIP from that stapled app.
6. Creates a DMG containing `loopdrop.app` and an Applications symlink, signs,
   notarizes, staples, and Gatekeeper-validates the DMG.
7. Generates v0.1 transition metadata, checksums, and GitHub artifact
   attestations.
8. Creates a **draft** release with an exact four-file allowlist.

The workflow never publishes a release automatically.

## Review the draft

Before publishing:

- verify the tag, plist version, filenames, checksums, and release notes agree;
- download the DMG as a user would, open it, drag Loopdrop to Applications, and
  launch it normally without a Gatekeeper bypass;
- run `codesign --verify --deep --strict`, `spctl --assess`, and
  `xcrun stapler validate` on the downloaded artifacts;
- convert real MOV, MP4, and M4V samples on Apple silicon and Intel;
- verify drag and drop, Finder selection, preview, clear, settings, background
  conversion, cancellation, Downloads naming, and normal quit;
- confirm manual current/available/offline update-check states;
- confirm the bundle contains no unexpected framework, helper, executable, or
  third-party notice and remains below the release size ceiling;
- verify `SHA256SUMS` and representative GitHub attestations; and
- test the signed v0.1.0-to-v0.2.0 updater transition on both architectures
  before publishing v0.2.0. The native app deliberately uses manual updates
  after that one-way migration.

If any source or artifact is wrong, delete the **draft**, fix the source, and
issue a higher version/tag. Never reuse a tag or replace a published asset.

Once all QA passes, publish the draft as the latest stable release.

## Failed or compromised releases

- Rerun the same workflow only for a transient infrastructure failure while its
  release remains a draft and its tagged source is unchanged.
- For a source fix, use a higher patch version and a new annotated tag.
- For a broken published build, publish a higher version; do not modify the old
  release.
- For a suspected signing-key or workflow compromise, keep new releases draft,
  revoke or rotate the credential, audit provenance, and follow
  [SECURITY.md](../SECURITY.md).
