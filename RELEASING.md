# Releasing Maranki

Releases are cut from **git tags**. Pushing a tag that starts with `v` triggers
the [`Release APK`](.github/workflows/release-apk.yml) workflow, which runs the
tests, builds a release APK, and publishes it to the repo's **Releases** page as
a downloadable file.

## Cut a release

1. Decide the version. Keep it in sync with `expo.version` in `app.json`
   (currently `2.0.0`). Bump `app.json` first if you're raising the version.
2. Commit any changes and make sure `main` is green.
3. Tag and push:

   ```sh
   git tag v2.0.1
   git push origin v2.0.1
   ```

4. Watch the **Actions** tab. In ~15–25 min the run finishes and a new entry
   appears under **Releases** with `maranki-v2.0.1.apk` attached.

To download on an Android phone: open the release, tap the `.apk`, and allow
"install from this source" if prompted.

### Version numbers, explained

- **versionName** (what users see) comes from the tag: `v2.0.1` → `2.0.1`.
- **versionCode** (the integer Android compares for updates) is set to the
  workflow **run number**, so it always increases. You never bump it by hand.
- `app.json` / `package.json` versions are for local `expo run` builds; the
  published APK's version is driven entirely by the tag.

### Manual build (no publish)

From the **Actions → Release APK → Run workflow** button you can build an APK
without cutting a release. Leave the tag input blank to just get an artifact,
or fill it in to also publish a Release.

## One-time: real signing (recommended before your first public release)

Out of the box the APK is **debug-signed** — it installs by sideload, but
different builds may not upgrade cleanly over each other. To sign every build
with your own stable key (so updates install over the current app), run once:

```sh
bash scripts/setup-release-keystore.sh
```

This creates `release.keystore` (gitignored — **back it up privately**) and
uploads four secrets to the repo:

| Secret                      | What it is                          |
| --------------------------- | ----------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | the keystore file, base64-encoded   |
| `ANDROID_KEYSTORE_PASSWORD` | store password                      |
| `ANDROID_KEY_ALIAS`         | key alias (`maranki`)               |
| `ANDROID_KEY_PASSWORD`      | key password                        |

Once these exist, the workflow automatically switches from debug signing to
your release key — no workflow change needed.

> ⚠️ Losing `release.keystore` means you can never publish an update that
> installs over the existing app. Treat it like a password.

## What the pipeline does

```
push tag vX.Y.Z
      │
      ▼
 npm ci → npm test           (release is gated on green tests)
      │
      ▼
 expo prebuild -p android    (regenerates the gitignored android/ project)
      │
      ▼
 gradlew assembleRelease     (+ injected version & signing)
      │
      ▼
 gh release create           (publishes maranki-vX.Y.Z.apk)
```
