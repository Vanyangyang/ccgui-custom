#!/usr/bin/env bash
# Local signed (+ notarized) macOS release build.
# Mirrors .github/workflows/release.yml so local builds carry the same stable
# Developer ID identity — that stable identity is what makes macOS TCC
# permissions ("Desktop folder access" etc.) survive rebuilds and updates.
#
# One-time prerequisites:
#   1. Developer ID Application certificate in the login keychain
#      (already present: "Developer ID Application: kunpeng zhu (RLHBM56QRH)")
#   2. Notary credentials profile (only needed for notarization):
#        xcrun notarytool store-credentials ccgui-notary \
#          --apple-id <your-apple-id-email> \
#          --team-id RLHBM56QRH \
#          --password <app-specific-password from appleid.apple.com>
#
# Env:
#   NOTARY_PROFILE   notarytool keychain profile (default: ccgui-notary)
#   SKIP_NOTARIZE=1  sign only, skip notarization (TCC fix does not need it)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  updater key password (prompted if unset)
set -euo pipefail
cd "$(dirname "$0")/.."

export APPLE_SIGNING_IDENTITY="Developer ID Application: kunpeng zhu (RLHBM56QRH)"

# Updater (minisign/rsign) key, stored base64-encoded at ~/.tauri/codemoss-new.key.
# TAURI_SIGNING_PRIVATE_KEY expects the base64 blob as-is (same as CI's
# TAURI_SIGNING_PRIVATE_KEY_B64 secret) — do NOT decode it.
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  KEY_FILE="$HOME/.tauri/codemoss-new.key"
  [ -f "$KEY_FILE" ] || { echo "error: updater key not found: $KEY_FILE" >&2; exit 1; }
  TAURI_SIGNING_PRIVATE_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
  export TAURI_SIGNING_PRIVATE_KEY
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  read -rsp "updater key password: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

pnpm exec tauri build --bundles app,dmg

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "SKIP_NOTARIZE=1 — bundle is signed but not notarized."
  exit 0
fi

NOTARY_PROFILE="${NOTARY_PROFILE:-ccgui-notary}"
DMG="$(find src-tauri/target/release/bundle/dmg -maxdepth 1 -name '*.dmg' | head -n 1)"
[ -n "$DMG" ] || { echo "error: no dmg produced" >&2; exit 1; }

xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"

echo "done: $DMG"
