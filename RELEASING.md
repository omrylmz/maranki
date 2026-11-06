# Releasing Maranki

Releases are cut from **git tags**. Pushing a tag that starts with `v` triggers
the [`Release APK`](.github/workflows/release-apk.yml) workflow, which runs the
type check, lint and tests, builds **one release APK** for the generic app, and
publishes it to the repo's **Releases** page as a downloadable file:

| Variant | App | Package | APK |
| ------- | --- | ------- | --- |
| `generic` | Maranki | `com.omrylmz.maranki` | `maranki-vX.Y.Z.apk` |

The German variant is built only on your own computer: see
[The German decks](#the-german-decks).

## The CI gate (every pull request and push)

The [`CI`](.github/workflows/ci.yml) workflow runs on every pull request and on
every push to a branch. It runs the same four checks as `npm run verify`:

| Step | Command | What it proves |
| ---- | ------- | -------------- |
| Deck files | `bash scripts/check-no-deck-files.sh` | git tracks no deck or app file |
| Type check | `npx tsc --noEmit` | the TypeScript types are correct |
| Lint | `npx expo lint` | ESLint, incl. the React Compiler / react-hooks rules |
| Tests | `npx jest --ci` | the whole jest suite passes |

**Install the pre-push hook once in each clone** (its worktrees share it). CI runs
after the push and
sees only the last commit, so it cannot stop a deck. The hook stops every push
that holds a deck in any commit. It reads file names only, so it cannot see real
text inside a `.json` file:

```sh
install -m 755 scripts/pre-push "$(git rev-parse --git-common-dir)/hooks/pre-push"
```

**A red CI run means: do not merge.** Run `npm run verify` locally before you
push; it is the same gate. The release workflow runs these checks again before
it builds, so a broken commit can never become an APK.

## Cut a release

1. Decide the version. Keep it in sync with `expo.version` in `app.json`
   (currently `3.0.0`; `app.config.ts` keeps it for both variants, and the
   Settings footer shows it). Bump `app.json` first if you're raising the
   version.
2. Commit any changes and make sure the **CI** run on `main` is green. **Tag
   only a commit that is already on the public `main`.** A local branch can hold
   the private decks, and a tag publishes them. Run this, and go on only when it
   prints `OK to tag`:

   ```sh
   git fetch origin && git merge-base --is-ancestor HEAD origin/main && echo 'OK to tag' || echo 'STOP: this commit is not confirmed on public main'
   ```

3. Read [Signing keys](#signing-keys--read-before-you-change-anything) below.
4. Tag and push:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. Watch the **Actions** tab. The checks run once, then the app builds. In
   ~15–25 min the run finishes and a new entry appears under **Releases** with
   `maranki-vX.Y.Z.apk` attached.

To download on an Android phone: open the release, tap the `.apk`, and allow
"install from this source" if prompted.

Before each build, the workflow checks the bundle: the APK must carry **no**
`.apkg` file. If it does, the run stops before Gradle.

### Version numbers, explained

- **versionName** (what users see) comes from the tag: `v2.0.1` → `2.0.1`.
- **versionCode** (the integer Android compares for updates) is set to the
  workflow **run number**, so it always increases. You never bump it by hand.
- `app.json` / `package.json` versions are for local `expo run` builds. The
  published APK's versionName comes from the tag, but the Settings footer shows
  the version in `app.json`, so keep the two equal (step 1 above).
- The policy is **roll forward**: Android never installs a lower versionCode
  over a higher one, so a bad release is fixed by a newer release, not undone.

### Manual build (no publish)

From the **Actions → Release APK → Run workflow** button you can build the APK
without cutting a release. Leave the tag input blank to just get the artifact
(`apk-generic`), or fill it in to also publish a Release.

## Build variants

Maranki German is **not a second app any more**. It is the same codebase built
with `APP_VARIANT=german` (spec §9.4). The old fork is folded back in; after the checks below pass, it is archived (read-only),
never deleted.

| | generic (default) | german |
| --- | --- | --- |
| `APP_VARIANT` | not set, or `generic` | `german` |
| App name | Maranki | Maranki German |
| Package / bundle id | `com.omrylmz.maranki` | `com.omrylmz.marankide` (the fork's package: fork users upgrade in place) |
| URL scheme | `maranki` | `marankide` |
| Content pack | `src/variants/generic/pack.ts` (adds nothing) | `src/variants/german/pack.ts` |
| Bundled decks | none | `assets/packs/german/` — German vocabulary (version 4), grammar (version 2), verbs (version 5) (9,105 notes, 17,304 cards). **Not in this repo:** see [The German decks](#the-german-decks) |

Three places read `APP_VARIANT`, and they must always agree:

1. **`app.config.ts`** — the app name, package id, scheme and `extra.variant`.
   `app.json` is the static base it builds on (plugins, icons, splash); the
   fields that differ per variant are only in `app.config.ts`. An unknown
   `APP_VARIANT` stops the build with an error.
2. **`metro.config.js`** — the module `@variant/pack` is the pack file of the
   variant. Only that file's decks get into the bundle, so the generic app never
   carries the German decks (about 6 MB).
3. **The native project** — `expo prebuild` writes the package id into
   `android/`. The folder is generated (not in git) and keeps the package of
   the LAST prebuild.

At run time the app checks that 1 and 2 agree (`pack.id === extra.variant`,
`src/variants/index.ts`): in a development build a mismatch is a red screen that
names the fix; a release build logs it and uses the generic pack.

### Run a variant locally

```sh
npm run start:german      # APP_VARIANT=german expo start --clear
npm run android:german    # android/ for com.omrylmz.marankide, then expo run:android
npm start                 # generic (APP_VARIANT not set)
npm run android           # android/ for com.omrylmz.maranki, then expo run:android
```

**Switching variants — always both of these:**

- **Restart Metro with `--clear`.** A running Metro (and its cache) can serve the
  OLD pack to the new app. `npm run start:german` already clears; for the
  generic app use `npx expo start --clear`. Stop the old Metro first: `expo
  run:android` uses a Metro that is already running on port 8081.
- **The native project must be made for the variant.** `android/` is generated
  (not in git) and keeps the package id of the LAST prebuild. `npm run android`
  and `npm run android:german` look at it first: they read the
  `applicationId` line in `android/app/build.gradle`.
  - **Another variant's id, or no `android/`** → `expo prebuild -p android
    --clean`: the folder is deleted and made again for this variant. The
    script sets `EXPO_NO_GIT_STATUS=1` for this call. Why: with `--clean`,
    prebuild asks "Continue with uncommitted changes?" when the git tree is
    dirty (the normal state while you work). A "No" there makes prebuild
    stop with exit code 0, so `&& expo run:android` would still run — with
    the OLD folder, and install one variant's package over the other app's
    data. `android/` is generated and git-ignored: there is nothing to lose
    in it.
  - **This variant's id** → a plain `expo prebuild -p android` (no
    `--clean`): it writes the config again (name, scheme, plugins) into the
    folder and KEEPS `android/app/build`, the CMake `.cxx` output and the
    Gradle state. So the build after it compiles only what changed.

  **What it costs** (measured, see "Checked in review round 2" below). A
  switch deletes `android/` with the app module's build output and the
  Gradle state of the project, so every Gradle task runs again (about 30 s
  on this Mac; the C++ output of the libraries lives in `node_modules` and
  is kept, so ninja has little to compile; the very first build in a fresh
  checkout compiles it: about 1 min). A run of the same variant adds only
  the plain prebuild (about 2 s), and Gradle finds almost everything up to
  date (4 s). A plain `npx expo run:android` does NOT run prebuild when
  `android/` exists: after a German build it installs the generic JS as
  `com.omrylmz.marankide`, on top of the German app's data. Use the scripts.

  (History: before W5-1 review round 1, `npm run android` was only `expo
  run:android`, with the problem above. Round 1 ran `prebuild --clean` on
  EVERY run: `android/` deleted and every Gradle task run again each time,
  and a "No" at the git prompt still ran the old folder. Round 2 made the
  check above.)

`prebuild --clean` makes the same `android/app/debug.keystore` every time (it
comes from the prebuild template), so local debug builds keep their signing
key: a switch never changes the key.

Checked on 2026-10-24 (unit W5-1, `expo prebuild -p android --clean --no-install`):
`APP_VARIANT=german` → `applicationId 'com.omrylmz.marankide'`, app name
"Maranki German", scheme `marankide`; no `APP_VARIANT` →
`applicationId 'com.omrylmz.maranki'`, "Maranki", scheme `maranki`. The
German prebuild's `android/app/debug.keystore` has the certificate SHA-256
`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` — the
same template debug key as the generic builds (see "Signing facts").
Checked again in review round 1: a German prebuild, then the first half of
`npm run android` (`APP_VARIANT=generic expo prebuild -p android --clean
--no-install`) → `applicationId 'com.omrylmz.maranki'`, "Maranki", and the
same `debug.keystore` digest `fac617…3b9c`.

Checked in review round 2 (2026-10-24, this Mac, emulator API 36). The git
tree was dirty each time; the `--clean` runs printed no git check at all
(`EXPO_NO_GIT_STATUS=1`), so no prompt can stop them half way:

| Run | Prebuild | Gradle | Whole run |
| --- | --- | --- | --- |
| `npm run android:german`, no `android/` yet | `--clean`, no prompt | 1 min 11 s (214 tasks run, 141 from Gradle's cache; the libraries' C++ compiled) | 3 min 18 s (with `expo run:android` waiting for the app to open) |
| `npm run android:german` again (same variant) | plain ("reusing /android") | 4 s (336 of 355 tasks up to date) | 8.7 s |
| switch: the prebuild half of `npm run android` after the German build | `--clean`, no prompt, 1.6 s | `assembleDebug` (arm64-v8a, as `expo run:android` builds it): 30 s, 327 tasks run | about 32 s |

After the switch: `applicationId 'com.omrylmz.maranki'`, app name
"Maranki", and only the scheme `maranki` in `AndroidManifest.xml` (no
`marankide` left over: `--clean` is why a switch never keeps the other
variant's scheme; a plain prebuild only ADDS schemes). The jest test
"android / android:german: a CLEAN prebuild only when …" in `pack.test.ts`
runs the two scripts with a fake `expo` for all three cases (no `android/`,
the other variant's, this variant's) and for a prebuild that fails.

### Card-type presets (every import, not only the starter decks)

The German pack's card-type presets (`cardTypePresets` in `pack.ts`) are used
by **every** import in the German app whose card type has a matching name: the
starter decks, and also a file or an AnkiWeb deck the learner imports
(`src/app/import.tsx` gives `activePack.cardTypePresets` to `suggestMapping`).
So `German_Complete.apkg` imported by hand (emulator checks E2 and E10) reads
the grammar questions in English and shows the labels "Verb forms",
"Präteritum", "Case / preposition" and the "Verb type" filter. The generic
app has no presets, so its imports are unchanged.

### The German decks

**The decks are private, and this repo is public.** So the three `.apkg` files
are not in git (`.gitignore` has `*.apkg`), and CI builds **only the generic
app**: `release-apk.yml` does not build the German variant, because a German
APK on the public Releases page would give the decks away.

To build the German variant, on your own computer:

1. Copy `German_Vocabulary.apkg`, `German_Grammar.apkg` and `German_Verbs.apkg`
   from your private copy into `assets/packs/german/`. Use the versions that
   `src/variants/german/pack.ts` names.
2. Run `npm run android:german` as usual. Without the files Metro stops with
   "Unable to resolve … German_Vocabulary.apkg".

The tests do not need the files: `pack.test.ts` uses fake assets, and the
fixtures are made up (see [Test fixtures](#test-fixtures)).

### Starter decks and their version

The German pack lists its decks in `src/variants/german/pack.ts`
(`starterDecks`). Each has a fixed `key` (`vocabulary`, `grammar`, `verbs`) —
**never change a key**: the deck in a learner's library is found by
`sourceKey = 'pack:german:<key>'`. When a bundled file changes (for example the
rebuilt vocabulary deck of 2026-10 with `Type` and `Plural` fields, spec §9.6,
which is version 2, and version 3 with ONE `Examples` field and no
`MarankiExample`):

1. Copy the new `.apkg` over the old one in `assets/packs/german/`.
2. Bump that deck's `version` in `pack.ts`.
3. Regenerate its fixture (see [Test fixtures](#test-fixtures)): `pack.test.ts`
   checks that the presets match its card-type and field names.

Learners then see **"Update German vocabulary (keeps your progress)"** in the
Today "+" sheet. It is the same idempotent add as the first one: notes are
matched by their Anki guid, every card keeps its progress. What the update
does (`src/domain/starterDecks.ts`, `src/domain/import/plan.ts`):

- **Changed notes are updated** (fields and tags), **new notes are added** to
  the same deck. A note the new file moved to another subdeck moves to that
  section (the 2026-10 update moved 62 words to another level), so the
  Section and Level filters still agree.
- **New and removed fields are applied.** When the card type of the new file
  has other fields or more directions (vocabulary version 2 added `Type` and
  `Plural`; version 3 removed `MarankiExample`), the planner upgrades the card
  type in place (`upgradeNoteType`): it keeps its id and the learner's own
  field settings, gets the new fields with the pack presets, loses the removed
  ones, and every note of it gets the new values (notes that are not in the
  file get empty ones). The deck keeps ONE card type, and `Type` becomes a
  filter group in the Library. **No text is lost:** a removed field stays (last,
  on no side of the card) while a note the file does not update — a retired
  note, the learner's own card — still has text in it; the reducer checks this
  again when it applies the plan. An import after that text is gone removes
  the field.
- **A change in the template text alone is not applied.** A card type with the
  same field names and the same directions (template `ord`s) is reused as it
  is: the planner does not compare the template text. Verbs version 4 is such
  a file (`{{CaseInfo}}` instead of `{{{CaseInfo}}}`, which this app reads the
  same way), so the update from version 3 to version 4 alone answers "Already
  up to date.". A newer file that MOVES a field to the other side of a card
  needs a planner change first.
- **Notes the new file dropped are retired**, not deleted: their cards are
  suspended (they leave the study queue, the progress stays) and the note gets
  the tag `not_in_new_version` (the Tags filter shows "not in new version").
  The snackbar says so: "… 245 old items are not in the new version, so they
  are suspended." The learner can delete them, or unsuspend them to keep
  studying them (a tagged note is never retired again). Only the starter deck
  itself is looked at, and only notes with the file's own guid. The vocabulary
  update of 2026-10 retires 245 duplicates and broken entries.

One limit to know before such an update (written in the code):

- **Which version a deck came from is read from its notes** (`source.ref =
  'pack:german:<key>@<version>'`), because the state has no field for it. An
  update that adds no note (it only changes field values) leaves the old
  number in the notes. So when an add finds the deck up to date with the
  bundled version, the sheet remembers "deck → version" **on this device**:
  the kv-store key `maranki.starterChecked` in `maranki-kv.db`, the same file
  as the theme choice (`src/components/sheets/AddSheet.tsx`,
  `readCheckedVersions` / `saveCheckedVersions`). It lasts after a restart, so
  the "Update" row does not come back. Limits: it is **not** in a backup, and
  it is gone after "Clear storage" or a reinstall. Then the row offers the
  update once more, and that tap answers "Already up to date." and remembers
  it again; nothing is ever changed twice. The right home is a field of the
  deck (for example `Deck.packVersion`, written by `applyImport` for a
  starter plan): a model and reducer change, planned for after wave 5.

A starter deck added from the Today "+" sheet follows the import screen's
rule for new cards (spec §5.9, decision D3): a NEW deck with **more than
1,000 new cards** (German vocabulary 15,034, German verbs 1,364) starts **Not
started**, and the snackbar offers **"Choose what to learn"**; a smaller one
(German grammar, 906) goes into the study queue. Onboarding's "Start with
German" adds all three as Not started (together 17,304 cards) and ends in
"Choose what to learn".

### Decision: fork decks after an in-place upgrade

A fork user who upgrades in place keeps the decks the fork made: "German
Verbs", "German Grammar" (and "German Vocabulary", if they added it). The fork
gave them **no `sourceKey`**, and `migrate()` gives their notes new ids
(`guid = 'm-<card id>'`), so neither the sourceKey nor an Anki guid connects
them to the bundled files. Without a check, the "+" sheet would say "Add",
and a tap would make a **second** deck with all the cards again, next to the
learner's own deck with their progress.

What the app does (review round 1, `starterLookalikes` in
`src/components/sheets/AddSheet.tsx`): when there is no starter deck yet, but
a deck with **no sourceKey** has the starter's name (case, accents and spaces
ignored: "German Verbs" = "German verbs"), the row says **"You may already
have this deck: German Verbs"**, and "Add" asks first (**"Add a second
copy?" · "Add anyway"**). Nothing is added without that second tap.

Not done, on purpose: a one-time step that tags the fork's decks with the
starter `sourceKey`. The match by name is only a guess (a learner may have
renamed or edited the deck), and the fork's notes still could not be updated
by guid, so a tagged deck would answer "Add again" with a second set of
notes. The fork decks keep working as normal decks (Level filter, gender
colours, progress). E12 checks the row and the question.

### Open design choice: the German icon

Both variants use the same icon files (`assets/images/`). The fork's icon was
byte-identical to the generic one, so there is no German icon to carry over.
If the German app should look different on the home screen, design an icon,
add it under `assets/packs/german/`, and point the `german` entry of `VARIANTS`
in `app.config.ts` at it. The Android adaptive icon and the iOS icon variants
are set in `app.json` for both apps, so `app.config.ts` must then also set
`android.adaptiveIcon` and `ios.icon` for the German variant.

## Signing keys — read before you change anything

Android installs an update over the old app **only when both APKs are signed
with the same key**. If the key changes, Android refuses the update, and the
only way forward is to uninstall — **which deletes the learner's cards and
progress**. So the signing key is part of the user's data. The rules
(spec §9.5, decision D7):

1. **Never change the signing key of `com.omrylmz.maranki`.** The public
   v2.0.2 APK was built by CI and is debug-signed: the workflow falls back to
   the debug key of the prebuild template when `ANDROID_KEYSTORE_BASE64` is not
   set. Every release must be signed the same way (keep the secret unset) until
   rule 2 allows a change. Confirm the certificate with the "Signing facts" check
   below.
2. A release keystore may be adopted **only after a public release with real
   Export + Share and Restore has shipped**, and only with an in-app notice that tells learners to **export a backup first**. Then they reinstall
   and restore.
3. **German variant (`com.omrylmz.marankide`).** Fork users must get an
   in-place upgrade (`adb install -r`): the variant has the fork's package, and
   `migrate()` reads the fork's saved data (fixture `v0-german-fork.json`).
   "Export → Restore" is not a path for them (the fork cannot share or restore
   a backup). The first German variant build must be signed with the **same
   key as the installed fork build**, or Android refuses the upgrade, and
   uninstalling deletes the data:
   1. Find the fork APK on the phone and read its certificate and version code:

      ```sh
      adb shell pm path com.omrylmz.marankide        # prints package:/data/app/…/base.apk
      adb pull /data/app/…/base.apk fork.apk
      apksigner verify --print-certs fork.apk         # "Signer #1 certificate SHA-256 digest: …"
      adb shell dumpsys package com.omrylmz.marankide | grep versionCode
      ```

   2. Build the variant with that key, and compare the digests. The prebuild
      template's debug key (`android/app/debug.keystore`, the same file after
      every `expo prebuild --clean`) has the certificate SHA-256
      **`fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`**;
      a local `npm run android:german` build is signed with it, and so is a CI
      build of the generic app without the keystore secret. Read a keystore's digest with:

      ```sh
      keytool -list -v -keystore android/app/debug.keystore \
        -alias androiddebugkey -storepass android | grep SHA256
      ```

      If the fork shows another digest, build with THAT keystore instead (for
      example `~/.android/debug.keystore`), never with a new one.
   3. The variant's **versionCode** must be at least the fork's: Android never
      installs a lower one. A local `expo run:android` build has versionCode 1
      (`app.json` sets none). A German build is always local.
   4. `adb install -r` the variant over the fork and run emulator check E12:
      the fork's cards and progress must still be there.
   5. Only after the variant has real Export + Share may its key change —
      export first, then reinstall and restore.
4. **The keystore secret signs only the generic app.** The release workflow
   builds only that APK. Setting `ANDROID_KEYSTORE_BASE64` changes the key of
   `com.omrylmz.maranki`, so rules 1 and 2 must allow it first. A German build
   is signed on your own computer.

### Later (only after v2.2.0): a release keystore

When rule 2 allows it, run once:

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
your release key — no workflow change needed (rule 4).

> ⚠️ Losing `release.keystore` means you can never publish an update that
> installs over the existing app. Treat it like a password.

## Device facts

Facts about real devices that the code depends on. Each one must be **measured
on the emulator** and written here with the date and the build. The two spikes
below were planned for wave 0; they moved to the **final emulator pass** (spec
execution notes). The Metro alias spike needs no device and is done (W5-1); the
2 MB spike is still open.

- [ ] **The 2 MB spike** (does the old storage lose a big library?).
  - Build: main@1333d48 debug build (`git worktree add ../maranki-1333d48 1333d48`,
    `npm ci`, `npx expo run:android`), Pixel emulator, API 34.
  - Steps: import `German_Complete.apkg` (both directions, ≈ 16k cards) →
    `adb shell am force-stop com.omrylmz.maranki` → open the app again.
  - Record: **does the read fail on relaunch (yes / no)**; the size of the
    `maranki.state.v1` value; `serialize()` time in ms; `AsyncStorage.setItem`
    time in ms (temporary `console.time` around both, read with `adb logcat`).
  - Result: _not measured yet_
- [x] **The Metro alias spike** (does the variant switch really pick one pack?).
  - Steps: with the wave-3 `metro.config.js` rule, run
    `APP_VARIANT=german npx expo export -p android --clear` and
    `npx expo export -p android --clear`.
  - Record: `@variant/pack` resolves to `src/variants/german/pack.ts` in the
    first export and to the generic pack in the second; **the generic export
    contains no `.apkg` file**.
    Switching variants without `--clear` can serve a stale bundle — always clear.
  - How to count the decks: `expo export` writes every asset under its HASH,
    with no file extension, so `find dist -name '*.apkg'` prints nothing even
    for the German export. Read the extension from `metadata.json`
    (`fileMetadata.android.assets[].ext`) — the release workflow does exactly
    this before every build.
  - Result (2026-10-24, unit W5-1, macOS, Node, no device —
    a bundler fact): **generic** — 90 files, 88 assets, **0** `.apkg`; the
    Hermes bundle has none of the German pack's strings ("Learn German. Keep
    it.", "Lexicographer"). **german** — 93 files, 91 assets, **3** `.apkg`
    (2,969,818 + 405,722 + 409,818 bytes, SHA-256 equal to
    `assets/packs/german/*.apkg`); the bundle has the German pack's strings.
    So the alias picks one pack per `APP_VARIANT`, and only that pack's decks
    are bundled. Run again after W5-1 review round 1 (same day, `--clear`):
    the same numbers — generic 90 files / 88 assets / **0** `.apkg`, no German
    pack strings; german 93 files / 91 assets / **3** `.apkg` with the same
    sizes and SHA-256, and the German pack strings. Run again in review
    round 2 (same day, `--clear`): the same numbers (generic 90 / 88 / **0**,
    no German pack strings; german 93 / 91 / **3**, 2,969,818 + 405,722 +
    409,818 bytes, the German pack strings).
- [ ] **Signing facts** (for the rules above).
  - Record: the certificate SHA-256 of the public v2.0.2 APK
    (`apksigner verify --print-certs maranki-v2.0.2.apk`), and of the fork
    build installed on the phone.
  - Result (partial, 2026-10-24): a **local** `assembleRelease` of tag v2.0.2
    and a local prebuild **debug** build of this branch are both signed with the
    template debug key, certificate SHA-256
    `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`, so
    `adb install -r` upgrades one to the other in place. The public CI-built
    v2.0.2 APK is not checked yet.
  - The fork build (2026-10-24, E12 below): the APK installed on the emulator
    (`adb shell pm path com.omrylmz.marankide` + `adb pull`) is the same file
    as the debug build of the old fork project
    (SHA-256 `fdbee3f7…8dad`), versionCode **1**, versionName 2.0.0 (the
    FORK's own version, read from that APK; this app is 3.0.0),
    certificate SHA-256 **`fac617…3b9c`** — the template debug key, the same
    key as a local `npm run android:german` build. So rule 3 holds for this
    fork build; a fork build on a real phone must still be checked the same
    way before its upgrade.
- [x] **E12 — the German variant** (spec §11; run in W5-1 review round 2,
  because the W5-1 acceptance names it; W5-4 runs it again in the final pass).
  - Steps: fresh install of `npm run android:german` → onboarding "Start with
    German" → "Where do you start?" A2 → the three decks are added (one line
    each) → "Choose what to learn" → study. Then: the Grammar question is read
    in English and a German word in German; gender colours; A–Z ignores the
    articles; Today "+" → the starter decks say "Added ✓", and "Add again"
    answers "Already up to date.". Then install the FORK build (same key, rule
    3), make progress, and `adb install -r` the variant over it. Today "+":
    the row of each deck the fork had says "You may already have this deck:
    German Verbs", and "Add" asks "Add a second copy?" before it adds
    anything ([the decision above](#decision-fork-decks-after-an-in-place-upgrade)).
    Kill and reopen the app after an "Update" of a newer bundled file: the
    row says "Add again", not "Update" again.
  - Record: the fork build's certificate digest and versionCode; that the
    fork's progress is there after the upgrade.
  - Result (2026-10-24, **PASS**): build = branch `unit/W5-1-fix2` (W5-1
    review round 2), debug APK from `npm run android:german` + Metro from
    `npm run start:german`, emulator "Resizable_Experimental" **API 36**
    (the spec asks API 34; the only AVD on this Mac). The fork build: the
    digest and versionCode under "Signing facts" above.
    - **The fork, with progress.** No fork project is needed to run the
      fork's debug APK: a 40-line stand-in for Metro served the fork's own
      cached dev bundle and cached fonts / `.apkg` files (copied from its data
      folder). The fork data already on the emulator (all three decks, 8,433
      cards, a 3.46 MB `maranki.state.v1` value) could **not be read by the
      fork itself**: `SQLiteBlobTooBigException: Row too big to fit into
      CursorWindow`, and the fork showed its first-run screens (the 2 MB
      problem of spec §0, seen on the fork build; the 2 MB spike above is
      still open for main@1333d48). So: `pm clear`, the fork's onboarding
      with German Grammar + German Verbs (1,588 cards, a 758 KB value), one
      session of 10 cards (Easy): 58 XP, streak 1, 1 session, 10 reviews;
      the fork opened again and read it.
    - **In-place upgrade** (`expo run:android` installs with `adb install -r
      -d`): the first-install time stayed 2026-07-13, so the data was kept.
      No crash, no data-problem screen, no onboarding. Today: streak 1,
      "New 10 / 10", "Study ahead · 10", the decks German Grammar and German
      Verbs. Progress: 58 XP, "1-day streak · best 1", "of 1,588 cards", the
      10 cards due in 4 days. Today "+": German vocabulary "Add"; German
      grammar and German verbs say "You may already have this deck: German
      Grammar" / "… German Verbs"; "Add" on German grammar shows "You may
      already have this deck: German Grammar. Add a second copy?" · "Add
      anyway", and nothing is added (still two decks).
    - **Fresh install** (`adb uninstall`, then `npm run android:german`
      again): "Learn German. Keep it." → Time → Reminder "Not now" → "Start
      with German · 8,433 words and grammar, A1 to C2" → "Where do you
      start?" **A2** → "Adding your decks…" with one line per deck ("13,690
      cards added · 1,162 cards marked Known", then grammar and verbs) →
      "Choose what to learn" 0 / 7,568: Learn, Learn, I know it, Later, Learn
      ("3 to learn · 1 known · 1 later") → Today "Study 3" → the session says
      "1 / 3" → Complete (+22 XP, streak day 1). The German grammar deck
      page: A1 Known 200, A2 216, B1 240, B2 250.
    - **Read aloud** (Google TTS in `adb logcat`): a German word →
      "Synthesis request for locale deu-DEU"; a Grammar question ("Which
      article goes with this case? …") → "Synthesis request for
      locale eng-USA".
    - **Gender colours**: "die Abfahrt" on the study card ("Practice this
      card"): "die" in the red of `c.danger`, "Abfahrt" in ink. The Library
      rows and the card sheet draw the term without colours (only the study
      card uses TermText, as built in wave 4).
    - **A–Z ignores the articles**: Library A–Z, search "Abf" → abfahren,
      die Abfahrt, der Abflug, departure, departure (flight), ….
    - **Starter rows**: all three "Added ✓" + "Add again"; "Add again" on
      German grammar → "Already up to date.".
    - **Update, then a restart**: with German grammar at `version: 2` (a
      temporary edit of `pack.ts`, never committed) the row said "Update
      German grammar (keeps your progress)"; the tap answered "Already up to
      date." (the same file: nothing to change) and the row became "Add
      again"; after `am force-stop` and a new start it still said "Add
      again" (the kv memory `maranki.starterChecked`).
    - Seen, not part of E12: the vocabulary field `MarankiExample` shows its
      raw name as the label ("MARANKIEXAMPLE"); the §9.4 preset table gives
      it no label.
    - Afterwards the emulator was put back as it was: the variant
      uninstalled, the fork APK installed again, and its original data
      restored (`RKStorage` SHA-256 equal to the copy taken before).
- [x] **E1 + E3 — upgrade from a real v2.0.2 install** (2026-10-24, emulator
  API 36, debug APK + Metro).
  - Setup: the v2.0.2 release build (local `assembleRelease` of the tag), first
    run, German decks (68 cards), one finished session (XP 34, streak 1),
    "die Stunde" favorited, "aufräumen" flagged, then a session force-stopped
    after 2 Good ratings (marker saved, payout not banked). Emulator snapshot
    `maranki-v202-data`. The exact `maranki.state.v1` value read from that
    device is the fixture `src/store/__fixtures__/v0-v2.0.2-device.json`.
  - E1 PASS: `adb install -r` kept the data; no crash, no data-problem screen,
    no onboarding, no notification prompt (`reminderEnabled` reset to false).
    68 cards, both decks, the favorite and the flag are kept; Library search "a"
    and A–Z sort work. The unfinished session was banked once and silently
    (XP 34 → 42 = 34 + 2×2 + 2×2). The kv-store `maranki-kv.db` holds schema 2
    (`front`/`back` + `legacy` on every card, 0 differences in SRS fields); the
    old RKStorage value is byte-for-byte unchanged; a `premigrate-v0-to-v2`
    file and a first automatic backup were written.
  - E3 PASS: 3 Good ratings → force-stop → relaunch banks once (XP 42 → 54, no
    Complete screen); a second relaunch changes nothing (XP 54).

## Test fixtures

**This repo is public, so every fixture made from the private decks is made up.**
It has the shape of the real data (the same card types, field names, levels, HTML
and links between versions). Long text is random. A short field keeps its word
count, word order and capital letters, among other things: the top of
`scripts/make-synthetic-fixtures.py` lists what stays. That script writes the fake
files from the real samples. It stops on a shape it does not know in the places
it checks, and its top comment names those places and the ones it does not check.
Three
state files (`v0-v2.0.2`, `v0-empty-library`, `v0-v2.0.2-device`) hold only the
public curated decks, so they stay as they are.

**The real samples stay on your own computer, in `.private-fixtures/`, which git
ignores. Never commit one, and never copy one into `src/`.** That folder must hold
every sample: all 8 in `.private-fixtures/anki/`, the 5 state files the script
names in `.private-fixtures/state/`, and `.private-fixtures/renames.txt`, which
lists the private names as `RealName=FakeName`, one per line. The script stops
without this file, so no private name goes back into the text of a fixture, and no
public file has to hold the names. A rename changes only the text, so give each
sample a neutral file name too. List every private name here, even one that no
fixture holds, except the names you decided to keep public (the code needs the
three bundled deck files, for example). `scripts/check-no-deck-files.sh` stops when
a tracked file holds a listed name, in its text or in its file name, also with a
space in place of `_`. It reads the list in the current checkout, then in the main
checkout: git does not copy an ignored folder into a new worktree, so keep the
folder in the main checkout, and do not use a link. With no list it prints
`Private names NOT checked` and goes on, as it does in CI. Make new fake files with:

```sh
python3 -I scripts/make-synthetic-fixtures.py .private-fixtures \
  src/domain/__fixtures__/anki src/store/__fixtures__
```

The `real fixture text` tests in `src/test/factories.test.ts` fail when a whole
real file comes back into one of the two fixture folders, under any name. They
cannot see a real file in any other folder, or one real note pasted by hand.
`extract-anki-fixture.py` refuses to write inside the repo, except into
`.private-fixtures/`. Run `npm run verify` before a push: CI runs only after it.

- `src/domain/__fixtures__/anki/*.json` — 20 notes per deck, in the shape of the
  real Anki decks. Make a real sample from a copy of the `.apkg` file with:

  ```sh
  python3 -I scripts/extract-anki-fixture.py path/to/German_Verbs.apkg \
    .private-fixtures/anki/german_verbs.json
  ```

  For a NEW version of a bundled deck, keep the sample of the old version under
  a new name and make the new sample from the same notes (same guids), so the
  update tests see updated, dropped and new notes. For version N, use a name
  that is not in use yet (the folder already has `_v1` and `_v2`):

  ```sh
  mv .private-fixtures/anki/german_vocabulary.json \
    .private-fixtures/anki/german_vocabulary_vN.json
  python3 -I scripts/extract-anki-fixture.py assets/packs/german/German_Vocabulary.apkg \
    .private-fixtures/anki/german_vocabulary.json --notes 20 \
    --keep-guids-from .private-fixtures/anki/german_vocabulary_vN.json
  ```

  Add the kept sample to `ANKI_FIXTURES` in `src/test/factories.ts`.

- `src/store/__fixtures__/*.json` — documents that old builds (v2.0.2, the
  German fork, main@1333d48) saved. They are made by running the old code; see
  `src/store/__fixtures__/README.md`. Regenerate with the command below. It reads
  the made-up Anki samples in the repo, so its output is made up too, and no real
  sample is needed. The `fork` and `all` steps also need `FORK_REPO` and
  `FORK_REF` (the old German fork).

  ```sh
  scripts/generate-state-fixtures.sh main       # or: v202 | fork | derived | all
  ```

  Only if the real samples must be the source, send the input and the output to
  the ignored folder, with absolute paths, and then run
  `make-synthetic-fixtures.py` as above:

  ```sh
  ANKI_DIR="$PWD/.private-fixtures/anki" OUT_DIR="$PWD/.private-fixtures/state" \
    scripts/generate-state-fixtures.sh main
  ```

## What the pipeline does

```
push tag vX.Y.Z
      │
      ▼
 verify: npm ci → tsc → lint → jest      (once; release is gated on the same checks as CI)
      │
      ▼
 build (APP_VARIANT=generic)
  expo export → 0 .apkg?         (the bundle check)
  expo prebuild -p android       (regenerates android/ with the package id)
  gradlew assembleRelease        (+ injected version & signing)
  maranki-vX.Y.Z.apk
      │
      ▼
 publish: gh release create      (one Release with the APK)
```
