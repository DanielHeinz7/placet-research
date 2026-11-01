# Signing and distributing the desktop app

How the macOS app gets from `desktop/` to a download that opens without a Gatekeeper warning, and
what to do on the day an Apple Developer account exists. Design:
`docs/superpowers/specs/2026-10-15-desktop-app-distribution-design.md`.

## What macOS shows for a test build

Measured on 2026-10-15 with macOS 26.5.2 on an Apple silicon Mac (German system language), with
copies marked as downloaded (`com.apple.quarantine`), never opened through "Open Anyway":

| Build | `codesign --verify --deep --strict` | `spctl --assess` | Dialog at first open |
|---|---|---|---|
| no signature (`identity: null`) | exit 1: `code has no resources but signature indicates they must be present` (the main binary carries only the linker's ad-hoc stub, nothing seals the resources) | exit 1: same message | "„placet-research" ist beschädigt und kann nicht geöffnet werden. Es empfiehlt sich, das Objekt in den Papierkorb zu bewegen." Buttons: "In den Papierkorb legen", "Abbrechen". This is the English "is damaged and can't be opened" dialog: no way to open it from the dialog or from System Settings. |
| ad-hoc, hardened runtime | exit 0: `valid on disk`, `satisfies its Designated Requirement` | exit 3: `rejected` | "„placet-research" nicht geöffnet. Apple konnte nicht überprüfen, ob „placet-research" frei von Schadsoftware ist, die deinen Mac beschädigen oder die Privatsphäre verletzen kann." Buttons: "In den Papierkorb legen", "Fertig". This is the English "Apple could not verify …" dialog; it is the kind that offers "Open Anyway" in System Settings, Privacy & Security (not pressed). |

Result: the spec's choice stands. A no-signature build is rejected as damaged, so test copies need at
least the ad-hoc signature that `mac.identity: "-"` produces. No app window opened in either case.
While the ad-hoc dialog was up, a `placet-research` process ran from a translocated path
(`/private/var/folders/…/AppTranslocation/…`); it was gone after the dialog was dismissed.

Screenshots of the damaged-app dialog and of the "could not verify" dialog were kept outside the
repository.

Git Credential Manager in the ad-hoc build: re-signed ad-hoc with the hardened runtime
(`CodeDirectory flags=0x10002(adhoc,runtime)`, no `Authority` line); in the unsigned build it keeps
its Microsoft signature (`Authority=Developer ID Application: Microsoft Corporation (UBF8T346G9)`,
`flags=0x10000(runtime)`). `codesign --verify --strict` on it passes in both. It does not start in
either build, for a reason that has nothing to do with signing: electron-builder leaves every `.dll`
and `.exe` out of `node_modules` on non-Windows platforms
(`app-builder-lib/out/util/appFileCopier.js`, `getNodeModuleExcludedExts`), and dugite's
`git-credential-manager` is a .NET apphost that needs `git-credential-manager.dll` beside it. The
built `libexec/git-core` has no `.dll` file, and `git credential-manager --version` exits 154 with
`The application to execute does not exist: …/git-credential-manager.dll`. The source tree
`desktop/node_modules/dugite` has them. Whatever Task 4 settles for `signIgnore`, the build also has
to bring those files in; not tried here.

## Turning signing on

Nothing in the code changes. Do these steps in order on the Mac that makes releases.

### Certificate

The Account Holder of the Apple Developer account creates the certificate; nobody else can
(developer.apple.com/support/developer-id). The private key is made on the release Mac and never
leaves it:

1. On the release Mac: Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority, "Saved to disk". This creates the private key in the login keychain.
2. The Account Holder uploads that request at developer.apple.com → Certificates → "+" →
   "Developer ID Application" and sends back the `.cer` file.
3. Double-click the `.cer` on the release Mac. `security find-identity -v -p codesigning` now lists
   `"Developer ID Application: <name> (<TEAMID>)"`.

### Notarization

Make an app-specific password (account.apple.com → Sign-In and Security → App-Specific Passwords) or
an App Store Connect API key. Then, in a terminal, so that the password is typed at the prompt and
never appears in a command line:

```bash
xcrun notarytool store-credentials research-harness-notary --apple-id <apple-id> --team-id <TEAMID>
```

`xcrun notarytool history --keychain-profile research-harness-notary` must then answer without an
error.

### Switch and first build

1. Fill in `desktop/distribution.json`:

   ```json
   {
     "signing": "developer-id",
     "identity": "Developer ID Application: <name> (<TEAMID>)",
     "teamId": "<TEAMID>",
     "notaryProfile": "research-harness-notary",
     "releases": "<owner>/<repository>"
   }
   ```

   `releases` names the GitHub repository the builds and the update feed are published to.

2. `cd desktop && npm ci && npm run dist`. Both builds go to Apple for notarization (minutes each).
   Expect no `problem:` line, a note "kept … file(s) signed by team UBF8T346G9" (Microsoft's Git
   Credential Manager), and `dist/release/latest-mac.yml`.
3. Test a downloaded copy. Upload one DMG to a draft release (`gh release create signing-test --draft
   desktop/dist/release/research-harness-mac-arm64.dmg`), download it in Safari from the draft's page,
   open it on a second user account, drag the app to Applications and open it. The only dialog may
   be "…is an app downloaded from the Internet. Are you sure you want to open it?". Then
   `gh release delete signing-test --yes`.
4. Add the section below to `README.md`, commit it together with `distribution.json`
   ("Turn on Developer ID signing for the desktop app"), and make the next release with
   `node scripts/release.js <version> "<summary>"`. Its `CHANGELOG.md` section says that the macOS app
   can now be downloaded.

### README section

```markdown
## Download the app (macOS)

- Apple silicon (M1 and later): [research-harness-mac-arm64.dmg](https://github.com/anonymous-owner/placet-research/releases/latest/download/research-harness-mac-arm64.dmg)
- Intel: [research-harness-mac-x64.dmg](https://github.com/anonymous-owner/placet-research/releases/latest/download/research-harness-mac-x64.dmg)

Not sure which Mac you have? Apple menu → About This Mac. "Chip: Apple M…" means Apple silicon;
"Processor: … Intel" means Intel.

Open the downloaded file and drag Placet into Applications. The first time you open it,
macOS asks whether you want to open an app downloaded from the Internet; choose Open.

The app looks for a new version on GitHub when it starts and once a day, downloads it, and installs
it when you quit. Turn this off under Placet → Check for Updates Automatically. GitHub sees
the request, as with any visit to its pages.
```

### First update (owner check)

After the release that turned signing on, install that version from the README link on a second user
account. Make the next release. Open the app there: within a minute the sidebar (or the start page)
says "Version … is ready". Choose Restart now; Placet → About Placet shows the
new version.

### Later

- Keep the same team for every release. An installed app takes only an update signed like itself, so
  a new team means everyone reinstalls once by hand.
- When the certificate expires, already published versions keep opening; new versions need a new
  certificate ("once your Developer ID certificate expires, you must be an Apple Developer Program
  member to get new Developer ID certificates to sign updates and new applications",
  developer.apple.com/support/developer-id). Repeat "Certificate" and update `identity` only if the
  name changed.
