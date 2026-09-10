# Change Log

All notable changes to the "keith-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.8.2] - 2026-09-10

The release of the 0.8.0 and 0.8.1 pre-releases below, unchanged: a bundled Java runtime in every
platform package, a downloadable C toolchain on Windows, diagrams pinned to the light palette,
and the document-highlight fix. The Marketplace requires a version number of its own for the
release channel.

## [0.8.1] - 2026-09-10 (pre-release)

- Diagrams are drawn with KIELER's light palette regardless of the VS Code colour theme. The
  dark palette that KLighD derives from dark editor themes is low-contrast; new setting
  `keith-vscode.diagramColorTheme` (`light`, default, or `editor` to follow the theme again)
  applies to open diagrams immediately.
- Package metadata points at the `Fallstop/sccharts-lab` repository.

## [0.8.0] - 2026-09-10 (pre-release)

- **Runs on a new computer without installing anything.** Marketplace and Open VSX builds are
  now platform-specific (Linux, macOS and Windows, x64 and arm64) and include a Java runtime:
  a `jlink` image of Eclipse Temurin 21 reduced to the eleven modules the language server
  needs, 30 MB compressed. One Linux machine links all six from the pinned JDKs in
  `server/runtime-manifest.json`. Measured alternatives: JustJ's smallest ready-made JRE is
  48 MB and lacks the `jdk.zipfs` module the server copies its C templates with; a Java 25
  image of the same modules is 2 MB larger, so 21 stays. An uncompressed jimage deflates
  better inside the VSIX than jlink's own compression (30 MB against 38 MB) and starts faster.
- Java is looked up in order: bundled runtime, `keith-vscode.javaHome` (new setting),
  `JDK_HOME`, `JAVA_HOME`, PATH, each checked for version 21 or newer. Without one, activation
  stops with a message offering the Temurin download and the setting instead of failing every
  command with `spawn java ENOENT`. **Restart KIELER language server** re-resolves, so a
  changed `javaHome` needs no reload. The universal `.vsix` is still built and still needs a
  Java 21 on the machine.
- **Windows C simulation without a toolchain**: the first C simulation offers to download
  w64devkit 2.9.1 (portable GCC, 61 MB, sha256-verified, self-extracting) into the extension's
  global storage, then restarts the server to use it. New commands **Download C toolchain**,
  **Remove downloaded C toolchain** and **Show Java runtime and C compiler in use**; new
  setting `keith-vscode.cCompilerPath` for an existing compiler on any platform. macOS and
  Linux get an install hint for the Command Line Tools or the distribution's gcc package
  instead of a generic compile failure. Java simulation checks for `javac` first and explains
  that it needs a JDK.
- The server takes its compiler from `-Dsccharts.cc` and runs `java`, `javac` and `jar` from
  the JVM it is executing on, so the bundled runtime never depends on PATH. The server build
  was repaired after its last two commits had left it unable to start (OSGi service loading,
  content-assist bindings of the non-SCTX languages, ELK's `Plugin` subclass) and now keeps
  the Eclipse runtime jars on the classpath, unstarted; it is 31 MB.
- Release workflow: verify, then a seven-way package matrix, a Windows job that runs the server
  suites on the bundled runtime with a freshly downloaded w64devkit, and one publish step for
  all packages. `publish-marketplace.cjs` takes several files and skips versions already
  published for a target platform.
- The language server is now built from source: the sccharts-lite fork compiles KIELER's
  SCCharts compiler, simulation and KLighD diagram server with plain Maven and Maven Central
  dependencies, without Tycho, Eclipse or OSGi, into a 29 MB JAR (the trimmed upstream JAR was
  37 MB, the original 94 MB). Esterel, Lustre, KiVis, verification, the KGraph/ELK text languages,
  the Eclipse workbench code and the Jetty visualization server are gone. Everything the former
  bytecode patch added (structured diagnostics, source tracing, scheduler cycle witnesses, loop
  explanations, C compiler mapping, string ownership in simulations, KLighD concurrency fixes,
  virtual generated files) is now ordinary source in the fork; `server-src/` and the ASM patch
  step are removed, and the Jetty 10 classpath override is no longer needed.
- Requires Java 21 (KLighD 3.1 and upstream KIELER are compiled for it). The server tracks
  upstream master (KLighD 3.1.0, ELK 0.11, Xtext 2.37, lsp4j 0.23.1) instead of the 2024 release.
- **Simulation visualization server** (`startVisualizationServer`) is not available in this build.

## [0.7.1] - 2026-09-09

- Fixed a diagram hang: when a show-snapshot task on the language server's main thread found
  its layout already finished, the follow-up ran on the main thread and queued a second layout
  behind itself, so the server waited for itself forever. Work requested from the main thread
  now runs inline. The release tests caught this once on a slow runner.

## [0.7.0] - 2026-09-09

- The extension is 38 MB instead of 90 MB. The upstream KIELER language server JAR is an
  Eclipse product export that shades in the Eclipse workbench, JDT, ICU locale data,
  BouncyCastle, JNA natives for every platform and ELK's documentation images; none of it runs
  in a headless language server. `fetch-server` now trims those packages out of the JAR before
  it is packaged, keeping any class that surviving code still references so the JVM verifier
  is satisfied. The real-server tests and a check across Esterel, Lustre, SCL, KGraph and ELK
  models behave identically on the trimmed JAR.
- The KIELER sidebar (compiler tree, model checker, simulation table) is gone, and with it the
  broken activity bar icon. Compiler stages are browsed with **Show Compilation Stage...**
  (**Stages** above the preview, the editor title menu, or the Command Palette). The model
  checker and the STPA import that fed it are removed.
- Compiling with a code-producing system opens the generated C or Java as read-only editor
  tabs, like **Generate Code**, instead of drawing the code in the diagram. When a stage is
  shown, a **Model** button above the preview returns to the SCChart; a finished compilation
  also brings the diagram back to the model. Clicking the code view no longer sends an
  Eclipse-only action to the language server, which threw a `NullPointerException` at the
  user; it opens the generated files instead.
- **Generate Code** is discoverable: an icon in the editor title of `.sctx` files and a **Code**
  button above the preview.
- Editing the simulated model marks the running simulation as stale and turns **Restart** into
  **Rebuild**, which compiles the model again with the same simulation system before starting
  over. Unsaved edits are saved first.
- Instantaneous-loop warnings on timed transitions now say so: the warning names the clock and
  lists the timed transitions instead of the unrelated entry actions on the path, and explains
  that the compiler checks each timeout in the tick the state is entered, why a clock reset on
  entry makes the loop advisory, and when it is not.

## [0.6.0] - 2026-09-08

- Generate C, Java, or both from SCCharts into read-only virtual code tabs. Save individual
  files with Save As or export a target's complete set to a folder. Generation failures and
  incompatible host-language extensions report source diagnostics; cancelled and stale
  builds cannot replace previews or write project files.
- Marketplace publishing reports actionable authentication errors and only treats a
  conflicting upload as successful after confirming that the requested version exists.

## [0.5.1] - 2026-09-08

- Renamed to SCCharts Lab with a new icon and published under the `qinnovate` publisher as an
  independent fork of KIELER VS Code. `yarn fetch-server` downloads and verifies the
  untracked language server and Jetty libraries; pushing a `vX.Y.Z` tag builds, tests, and
  publishes a GitHub release, the Marketplace, and optionally Open VSX.
- Refuses to activate beside the original KIELER VS Code extension, which registers the same
  commands and views, and offers to show it so it can be disabled.
- The compiler's "Instantaneous loop detected!" warning now names the operations on the
  loop, links to them, explains when it is advisory (a clock or variable reset on every
  transition of a delayed cycle) and how to break a real loop. When the scheduler rejects
  the same loop, its cycle error replaces the warning. The scheduler's per-edge messages
  stay in Technical details instead of appearing as separate problems.
- Overlapping diagram requests, such as showing a compiler stage right after a build or
  highlighting a conflict, no longer deadlock the language server or fail with
  `KNode.getParent()` null-pointer errors. The bundled server waited for KLighD's main
  thread while holding the lock that thread needed, and let a synthesis rebuild a diagram
  another request was still traversing. Callers that hand work to KLighD's main thread now
  wait on their own completion flag, so a wake-up can no longer land on the wrong caller and
  stall every diagram request. Show requests are also sequenced on the client.

## [0.5.0] - 2026-09-08

- Compilation failures appear in the diagram preview and VS Code Problems, with
  source links and related locations. Errors stay with their model and become stale
  when the source changes.
- Scheduler failures show one short dependency cycle per conflict, explain the
  required order, and link to the participating source operations and diagram.
  Compilation stops after errors, before an incomplete executable can be emitted.
- GCC and Clang diagnostics link to generated C and, where provenance is available,
  the original SCCharts assignment or embedded host C. Full compiler output remains
  available under Technical details.
- A quick fix expands compatible fixed-size array assignments into element copies.
  Scheduling conflicts offer timing guidance rather than automatic semantic changes.
- Preview controls and traces follow the displayed file; switching files clears
  unfinished edits and prevents controlling another model's simulation.
- Uninitialized string inputs remain editable. The C simulation wrapper retains
  incoming strings so empty inputs and values copied into outputs survive later ticks.
- Source links reuse the existing editor tab. Diagram highlighting returns to the
  original SCCharts diagram and waits for its source links before selecting and
  fitting the involved operations. Queued refreshes safely skip closed diagram contexts.

## [0.4.0] - 2026-09-07

- The diagram preview tab (`[Preview] model.sctx`) now carries the whole simulation. Restart / Step /
  Run / Stop, the tick counter and the delay between ticks sit above the diagram; a resizable trace
  drawer below shows every variable per tick, grouped into Inputs / Outputs / Variables / Generated.
  Inputs are edited in the "Next" column. Space steps, R runs or pauses.
- One-line "what happened this tick" summary: inputs present, outputs emitted, values that changed,
  and inputs queued for the next tick. Explanations live in tooltips.
- Per-variable number format (dec / hex / bin / chr) on integer rows, applied to the trace, the
  summary and typed values. `0x` / `0b` prefixes and quoted characters are always accepted.
- `deltaT` is a normal input row and defaults to 1 when a simulation starts, so timed models advance
  on Step. Clocks are visible; the compiler's tick-time measurement stays behind the Generated toggle.
- Diagrams no longer need `kieler.klighd-vscode`: the diagram code is part of this extension, with a
  "Restart diagram" command and automatic rebuild after a language server restart.
- Simulation ticks are serialised until the server acknowledges them; inputs edited mid-tick are kept
  and run loops cancel on pause or restart. Numeric and array inputs are validated before sending.
- The KIELER Simulation sidebar view still works but is no longer revealed automatically.
- Icons are inline SVG and the webview policy allows fonts, so controls render in every theme.
- Fixes: toolbar that grew a pixel per frame, hover tint leaking through sticky trace columns,
  history order flipping every tick, browser visualization server failing to start (Jetty 10 is put
  ahead of the bundled jar), and the diagram not reopening after being closed.

## [0.3.2-cs303] - 2026-09-07

- Restart KIELER language server command; readable simulation table; step/run/stop in editor title
  bars; keybindings while simulating.
