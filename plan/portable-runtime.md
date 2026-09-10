# Portable runtime: bundled JRE and Windows C toolchain

Status: implemented 2026-09-10 (extension working tree, uncommitted). Deviations from the plan
below, all measured:

- Not JustJ. The runtime is a `jlink` image of Eclipse Temurin 21 built by
  `keith-vscode/scripts/build-jre.cjs` from `server/runtime-manifest.json` (one pinned release,
  URL + sha256 per target). JustJ `minimal.stripped` is 48 MB and lacks `jdk.zipfs`, which the
  server needs (phase 0 found it: `ProviderNotFoundException: Provider "jar"`); the jlink image
  with the eleven required modules is 30 MB compressed, 91 MB on disk.
- Uncompressed jimage (`--compress zip-0`): 30 MB in the VSIX against 38 MB with `zip-9`,
  because the VSIX's own deflate works across the whole `lib/modules`; also faster start.
- Java 25 does not shrink anything: same modules are 2 MB larger. Stay on 21 (matches the
  server's class-file level).
- `javac` (`jdk.compiler` + `jdk.jartool`) is not bundled: +10 MB per platform for a secondary
  feature. Java simulation uses a JDK from `javaHome`/PATH and says so when none exists.
- Cross-linking from one Linux runner for all six targets, so no per-OS release runners.
- Option B of phase 3 was done in the fork after all: `HostTools` reads `-Dsccharts.cc` and
  runs `java`/`javac`/`jar` from the executing JVM. The extension still restarts the server
  after a download (the property is read at JVM start).
- `server/jre` is flat (`bin/java` at the top), no `Contents/Home` case to handle.
- The fork's last two commits had left the server unable to start; fixed in the fork
  (`eb85f80`), which is why the committed jar size is now 31 MB (Eclipse runtime jars stay on
  the classpath, unstarted, for ELK's `ElkServicePlugin`).

## Goal

Installing SCCharts Lab from the Marketplace must work on a machine with no Java and, on
Windows, no C compiler. Today the extension spawns a bare `java` from PATH
(`keith-vscode/src/extension.ts`, `createServerOptions`) and the server spawns a bare `gcc`
for C simulation. Both fail with generic errors when the tool is missing.

Decisions already made:

- JRE: Eclipse JustJ 21, `jre.minimal.stripped` flavour, embedded per platform.
- Windows C toolchain: w64devkit, downloaded on first use, not shipped in the VSIX.
- Linux and macOS keep using the system `gcc` (Xcode Command Line Tools on macOS).

## Current state

- Server: `keith-vscode/server/sccharts-lite-server.jar`, built from the sccharts-lite fork with
  `maven.compiler.release` 21. Class files are version 65, so Java 21 is the hard minimum.
- Launch: `java -Djava.awt.headless=true -cp <jar> de.cau.cs.kieler.language.server.LanguageServer`,
  no version check, no `JAVA_HOME`, no setting.
- Missing `java` surfaces as
  `KIELER Language Server client: couldn't create connection to server. Launching server using command java failed. Error: spawn java ENOENT`
  and `activate()` aborts at `await lsClient.start()` with commands already registered.
- C simulation: the server's `CCompiler` processor runs the property
  `de.cau.cs.kieler.kicool.deploy.compiler.c.path` (default `gcc`) through a `ProcessBuilder`,
  so whatever is on the server process's PATH is what gets used. Java simulation likewise
  spawns `javac` and `jar` (`JavaCompiler` processor, property
  `de.cau.cs.kieler.kicool.deploy.compiler.java.path`).
- Release: `.github/workflows/release.yml` builds one universal VSIX on ubuntu and publishes to
  the Marketplace via `scripts/publish-marketplace.cjs` and optionally Open VSX.

## Reference pattern

Red Hat's Java extension (`redhat-developer/vscode-java`):

- `scripts/jre.mjs` reads `https://download.eclipse.org/justj/jres/<ver>/downloads/latest/justj.manifest`,
  picks the entry matching the target, unpacks into `jre/` in the extension root.
- Platform mapping: `linux-x64 -> linux-x86_64`, `linux-arm64 -> linux-aarch64`,
  `darwin-x64 -> macosx-x86_64`, `darwin-arm64 -> macosx-aarch64`,
  `win32-x64 -> win32-x86_64`, `win32-arm64 -> win32-aarch64`.
- Release workflow loops targets: download JRE, `vsce package --target <t>`, then
  `vsce publish --packagePath <vsix>` per file, plus a universal VSIX with no JRE.
- Runtime: `findEmbeddedJRE` looks for `jre/*/bin/java` (`java.exe` on Windows). Order is
  embedded, then setting, then `JDK_HOME`, then `JAVA_HOME`, then PATH, each version-checked.

JustJ 21 sizes (compressed, measured 2026-09-10):

| flavour            | linux-x86_64 | win32-x86_64 | macosx-aarch64 |
|--------------------|--------------|--------------|----------------|
| minimal.stripped   | 49 MB        | 45 MB        | ~47 MB         |
| full.stripped      | 77 MB        | 74 MB        | 74 MB          |

w64devkit 2.9.1: `w64devkit-x64-2.9.1.7z.exe`, 61 MB self-extracting 7z, portable, contains
`bin/gcc.exe`, `make`, `busybox`. No installer, no registry, runs from any folder.

## Phase 0: verify the JRE flavour (do this before anything else)

`minimal.stripped` may lack modules the server uses. The launch passes
`-Djava.awt.headless=true`, which suggests `java.desktop` (fonts for KLighD layout) is on the
path somewhere, and minimal images usually drop it.

1. Download the linux-x86_64 `minimal.stripped` tarball, run `bin/java --list-modules`.
2. Run `jdeps --print-module-deps --ignore-missing-deps --multi-release 21 server/sccharts-lite-server.jar`
   on a JDK 21 and diff against the list.
3. Start the server with that JRE and run `yarn test:server` against it
   (`KEITH_LS_PORT` path or a temporary `SCCHARTS_JAVA` override, see phase 1).
4. If anything is missing, use `full.stripped` (about 25 MB more per platform) rather than a
   custom jlink; JustJ handles signing and updates for us.

Record the chosen flavour in `keith-vscode/server/jre-manifest.json` (phase 1).

## Phase 1: Java resolution in the extension

New file `keith-vscode/src/java-runtime.ts`:

- `findJava(context): Promise<{ command: string; version: number; source: string } | undefined>`
  tries, in order:
  1. `context.asAbsolutePath('server/jre')` any child with `bin/java[.exe]`.
  2. Setting `keith-vscode.javaHome` (new `contributes.configuration` entry, string, scope machine).
  3. `JDK_HOME`, then `JAVA_HOME` env, using `<home>/bin/java[.exe]`.
  4. `java` from PATH.
  Each candidate runs `java -version` with a 10 s timeout and parses the major version from
  stderr (`version "21.0.4"` or `version "1.8.0_..."`). Accept 21 or newer.
- Bundled JRE on Linux/macOS: check `bin/java` is executable and `chmod 0o755` the `bin/`
  entries if not. VSIX extraction usually keeps modes but has not always.
- Return `undefined` with a reason string when nothing qualifies.

Changes in `keith-vscode/src/extension.ts`:

- `createServerOptions` becomes async, takes the resolved java command, and passes
  `options.env` (phase 3 needs this for PATH).
- In `activate()`, resolve Java before creating the `LanguageClient`. On failure show
  `showErrorMessage('SCCharts Lab needs Java 21 or newer. <reason>', 'Download Java', 'Open Settings')`
  where Download opens `https://adoptium.net/temurin/releases/?version=21` and Settings opens
  `keith-vscode.javaHome`. Register only the restart command, log the reason to the output
  channel, and return. Restart re-runs resolution so setting `javaHome` works without reload.
- Log which java and which source was chosen on every start (output channel, one line).

Tests (`keith-vscode/test/java-runtime.test.cjs`): version parsing for Temurin 21, JustJ 21,
Java 8 style strings; resolution order with a fake filesystem; rejection of Java 17.

## Phase 2: embed JustJ per platform

Script `keith-vscode/scripts/fetch-jre.cjs --target <vscode target>`:

- Reads `server/jre-manifest.json`:
  ```json
  {
    "version": 21,
    "flavour": "minimal.stripped",
    "platforms": {
      "linux-x64":   { "justj": "linux-x86_64",   "sha256": "..." },
      "linux-arm64": { "justj": "linux-aarch64",  "sha256": "..." },
      "darwin-x64":  { "justj": "macosx-x86_64",  "sha256": "..." },
      "darwin-arm64":{ "justj": "macosx-aarch64", "sha256": "..." },
      "win32-x64":   { "justj": "win32-x86_64",   "sha256": "..." },
      "win32-arm64": { "justj": "win32-aarch64",  "sha256": "..." }
    }
  }
  ```
- Pin the JustJ build directory (for example `20260826_1017`) and the file name in the manifest
  instead of resolving `latest` at build time, so the sha256 stays valid. A `--refresh` mode
  fetches the current `justj.manifest`, rewrites URLs and hashes, and prints the diff.
- Downloads to `out/jre/<target>.tar.gz`, verifies sha256, extracts to `server/jre/<name>/`
  after `rm -rf server/jre`. On macOS the tarball has a `Contents/Home` layout in some
  JustJ builds; the runtime lookup must accept both `jre/*/bin/java` and
  `jre/*/Contents/Home/bin/java`.
- `--clean` removes `server/jre`.

Packaging:

- `.gitignore`: add `server/jre/`.
- `.vscodeignore`: nothing extra; `server/jre/**` is intentionally included when present.
- `package.json` scripts: `fetch-jre`, `package:platform` = `vsce package --yarn --target $TARGET -o sccharts-lab-$TARGET.vsix`.
- Universal VSIX stays as is with no `server/jre`, and phase 1 falls back to the system Java.

Release workflow (`.github/workflows/release.yml`):

- Keep the single `release` job for build, tests, universal package, and GitHub release.
- Add a `platform` job with `strategy.matrix.target` over the six targets, `needs: release`
  build outputs shared through `actions/upload-artifact` (the built server JAR and compiled
  `dist/`). Each matrix entry: `fetch-jre --target`, `vsce package --target`, upload VSIX.
- A final `publish` job downloads all VSIX files and calls `publish-marketplace.cjs` once per
  file, universal last. Extend that script to accept several paths and to skip a target that is
  already published (the gallery API returns 409 on duplicates, which it already handles).
- Open VSX: publish the platform VSIX files too (`ovsx publish --packagePath`), universal as
  fallback.
- Attach all seven VSIX files to the GitHub release.

Size expectations: universal ~30 MB, platform builds ~75 to 80 MB each. The Marketplace
already takes several minutes on the current package (see comment in
`publish-marketplace.cjs`); expect that per platform, so the publish job needs a long timeout.

## Phase 3: w64devkit on Windows for C simulation

Trigger and storage:

- On Windows, when the user starts a C simulation and `where gcc` fails
  (`spawnSync('where', ['gcc'])`), show
  `C simulation needs a C compiler. Download w64devkit (61 MB) into VS Code's storage?`
  with `Download` and `Use my own compiler` (opens setting `keith-vscode.cCompilerPath`).
- Install location: `context.globalStorageUri.fsPath/w64devkit/<version>/`. Never inside
  the extension folder, which is replaced on update.
- Manifest `server/toolchain-manifest.json`:
  ```json
  {
    "w64devkit": {
      "version": "2.9.1",
      "url": "https://github.com/skeeto/w64devkit/releases/download/v2.9.1/w64devkit-x64-2.9.1.7z.exe",
      "sha256": "...",
      "size": 61462208
    }
  }
  ```
- Download with progress (`window.withProgress`, cancellable), verify sha256, then extract.
  The file is a 7-Zip SFX. Extract by running it: `w64devkit-x64.7z.exe -o<dir> -y`
  (7-Zip SFX accepts `-o` and `-y`). No 7z dependency needed. Write a `installed.json`
  stamp with version and hash after success; remove the directory on any failure.
- Provide `keith-vscode.cCompilerPath` (string, machine scope) for people who have MinGW or
  MSYS2 elsewhere. Also honour it on Linux and macOS.

Wiring into the server:

- Option A (no server change): prepend `<install>/bin` to `PATH` in the `env` passed to the
  Java child process (phase 1 already routes `options.env`). The server's `CCompiler` finds
  `gcc.exe` on that PATH. Requires a server restart after first download; do it automatically
  through `restartLanguageServer` and then re-run the simulation request.
- Option B (server change, later): let the extension send the compiler path through the
  simulation request so the server sets `de.cau.cs.kieler.kicool.deploy.compiler.c.path`.
  Avoids the restart. Needs a fork change in sccharts-lite; defer.
- Go with A first.

Also add to PATH on every start when the stamp file exists, so the toolchain is picked up
without prompting again. The `Use my own compiler` choice is remembered in
`context.globalState` and suppresses the prompt.

Removal: command `SCCharts Lab: Remove downloaded C toolchain` deletes the directory.

Licensing: w64devkit is public domain (Unlicense) for its own parts; GCC and Mingw-w64 are
GPL/permissive respectively and are distributed unmodified from the upstream release, so no
extra obligations beyond linking to the source in the README.

Java simulation on Windows: JustJ JREs have no `javac`. Either document that Java simulation
needs a JDK on PATH (phase 1 resolution then prefers a JDK for that path) or drop the Java
simulation entry point. Decide after phase 0 shows whether `jdk.compiler` is in the chosen
flavour; assume not.

## Phase 4: docs, CI, and release notes

- `keith-vscode/README.md` Requirements: platform builds need nothing; universal build and
  Open VSX need Java 21 on PATH or `keith-vscode.javaHome`; Windows C simulation offers
  w64devkit on first use; Linux needs `gcc`, macOS needs Xcode Command Line Tools.
- `ci.yml`: add one Windows runner job that installs the universal build, runs `fetch-jre`
  for `win32-x64`, and runs `test:server` through the embedded JRE, so the Windows path is
  exercised before a tag.
- CHANGELOG entry under the next minor version.
- Bump `engines.vscode` only if `vsce --target` needs it (it does not; 1.61+ supports platform
  extensions, current engine is `^1.85.0`).

## Order of work

1. Phase 0 (half a day): confirm the JustJ flavour, record it in the manifest.
2. Phase 1 (one day): Java resolution, error UI, setting, tests. Ship as a patch release on
   its own; it already fixes the "ENOENT" experience for everyone.
3. Phase 2 (one to two days): fetch script, matrix workflow, publish loop. Ship as a minor
   release.
4. Phase 3 (one to two days): w64devkit download and PATH wiring. Ship as a minor release.
5. Phase 4 alongside 2 and 3.

## Open questions

- JustJ flavour (phase 0). Default answer: `minimal.stripped`; fall back to `full.stripped`.
- Whether to keep publishing a `win32-arm64` build. JustJ has `win32-aarch64`, but w64devkit
  is x64-only. Ship the JRE, let the x64 w64devkit run under emulation, note it in the README.
- Whether Java simulation stays supported without a JDK on the machine.
