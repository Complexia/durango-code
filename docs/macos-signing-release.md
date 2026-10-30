# macOS Signing and Notarization

Durango Code (internally Orion) macOS releases are distributed outside the Mac App Store as Developer ID signed and notarized DMGs.

## Local Prerequisites

Verify the Developer ID Application certificate is installed:

```bash
security find-identity -v -p codesigning
```

Expected identity:

```text
Developer ID Application: R&R Unicorns, LLC (KV46DBU287)
```

Store notarization credentials in the local macOS keychain:

```bash
xcrun notarytool store-credentials "orion-notary" \
  --apple-id "<APPLE_ID_EMAIL>" \
  --team-id "KV46DBU287" \
  --password "<APP_SPECIFIC_PASSWORD>"
```

Do not commit Apple passwords, generated certificates, private keys, `.p12` files, or build artifacts. The app-specific password belongs only in the local keychain.

## Configuration

`forge.config.js` signs macOS builds with:

```text
Developer ID Application: R&R Unicorns, LLC (KV46DBU287)
```

It enables Hardened Runtime and uses `build/entitlements.mac.plist`. The entitlement set is intentionally minimal for an unsandboxed Electron app:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation`

The release script uses the `orion-notary` keychain profile by default. Override locally only when needed:

```bash
ORION_MAC_SIGN_IDENTITY="Developer ID Application: R&R Unicorns, LLC (KV46DBU287)"
ORION_MAC_NOTARY_PROFILE="orion-notary"
```

## Release

Create `.env.release.local` from `.env.release.example`, then run:

```bash
bun run deploy
```

The deploy script bumps the app version, builds a macOS DMG and ZIP, verifies the signed app, signs the DMG, notarizes and staples the DMG, staples the app, repacks the ZIP for in-app updates, uploads both artifacts to R2 under `releases/v<version>/`, and updates `releases/latest.json`.

The public website downloads the DMG from `manifest.downloads.macos.<arch>`. The app updater uses the ZIP from `manifest.updates.macos.<arch>` through:

```text
https://durango.sh/api/update/macos/<arch>/latest-mac.yml
```

Useful overrides:

```bash
bun run deploy --bump minor
bun run deploy --version 1.2.3
bun run deploy --bump none
bun run deploy --resume-upload
```

If signing and notarization completed but an artifact upload failed, resume the
same version without rebuilding or submitting it to Apple again:

```bash
bun run deploy --resume-upload
```

If Apple accepts a submitted DMG after the local wait was interrupted, resume without rebuilding or resubmitting:

```bash
bun run deploy --resume-notary-id <SUBMISSION_ID>
```

That command waits for the existing signed-DMG submission, staples the local DMG in `out/make`, verifies it, uploads it to R2, and updates `releases/latest.json`.

## Manual Verification Commands

After packaging, verify the app:

```bash
codesign -dv --verbose=4 "out/Durango Code-darwin-arm64/Durango Code.app"
codesign --verify --deep --strict --verbose=2 "out/Durango Code-darwin-arm64/Durango Code.app"
spctl -a -vvv -t exec "out/Durango Code-darwin-arm64/Durango Code.app"
```

Notarize and staple the final DMG manually if needed:

```bash
codesign --force --sign "Developer ID Application: R&R Unicorns, LLC (KV46DBU287)" \
  --timestamp "out/make/Durango Code-<version>-arm64.dmg"
codesign -dv --verbose=4 "out/make/Durango Code-<version>-arm64.dmg"
codesign --verify --verbose=2 "out/make/Durango Code-<version>-arm64.dmg"
xcrun notarytool submit "out/make/Durango Code-<version>-arm64.dmg" \
  --keychain-profile "orion-notary" \
  --wait
xcrun stapler staple "out/make/Durango Code-<version>-arm64.dmg"
spctl -a -vvv -t open --context context:primary-signature "out/make/Durango Code-<version>-arm64.dmg"
```
