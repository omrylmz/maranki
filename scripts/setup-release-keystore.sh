#!/usr/bin/env bash
#
# One-time setup for signed, upgradable release APKs.
#
# Creates an Android release keystore and uploads it (plus its credentials)
# to this repo's GitHub Actions secrets, so the Release APK workflow signs
# every build with the SAME key. That consistency is what lets a new release
# install over an already-installed copy of the app — Android rejects an
# update signed with a different key.
#
# Run once, from the repo root:
#
#     bash scripts/setup-release-keystore.sh
#
# Requires: keytool (ships with any JDK), openssl, and an authenticated
# GitHub CLI (`gh auth login`).
#
# Skipping this is fine to start with — without these secrets the workflow
# falls back to Expo's debug signing and the APK still sideloads. But then
# each build may not upgrade cleanly, so set this up before your first real
# public release.

set -euo pipefail

KEYSTORE_FILE="release.keystore"
KEY_ALIAS="maranki"

# --- Preflight -------------------------------------------------------------

command -v keytool >/dev/null 2>&1 || { echo "❌ keytool not found — install a JDK (e.g. Temurin 17)."; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "❌ openssl not found."; exit 1; }
command -v gh >/dev/null 2>&1      || { echo "❌ GitHub CLI 'gh' not found — https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1     || { echo "❌ Not logged in — run 'gh auth login' first."; exit 1; }

if [ -f "$KEYSTORE_FILE" ]; then
  echo "❌ $KEYSTORE_FILE already exists. Refusing to overwrite it."
  echo "   Overwriting would create a NEW signing identity, and future updates"
  echo "   would stop installing over existing installs. Delete it by hand only"
  echo "   if you truly intend to start over."
  exit 1
fi

# --- Create the keystore ---------------------------------------------------

# One strong random password used for both the store and the key.
PASSWORD="$(openssl rand -base64 24)"

echo "🔐 Generating $KEYSTORE_FILE (RSA 2048, valid ~27 years)…"
keytool -genkeypair -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASSWORD" \
  -keypass "$PASSWORD" \
  -dname "CN=Maranki, OU=Mobile, O=omrylmz, C=US"

# --- Upload secrets --------------------------------------------------------

echo "☁️  Uploading secrets to GitHub…"
base64 -i "$KEYSTORE_FILE" | gh secret set ANDROID_KEYSTORE_BASE64
printf '%s' "$PASSWORD"    | gh secret set ANDROID_KEYSTORE_PASSWORD
printf '%s' "$KEY_ALIAS"   | gh secret set ANDROID_KEY_ALIAS
printf '%s' "$PASSWORD"    | gh secret set ANDROID_KEY_PASSWORD

cat <<EOF

✅ Done. Four secrets are set on the repo:
     ANDROID_KEYSTORE_BASE64
     ANDROID_KEYSTORE_PASSWORD
     ANDROID_KEY_ALIAS
     ANDROID_KEY_PASSWORD

⚠️  BACK UP "$KEYSTORE_FILE" somewhere private (a password manager, encrypted
   drive). It is gitignored and NOT committed. If you lose it you can never
   ship an update that installs over the current app — every user would have
   to uninstall and reinstall.

Next: push a tag to cut a signed release, e.g.

     git tag v2.0.1 && git push origin v2.0.1
EOF
