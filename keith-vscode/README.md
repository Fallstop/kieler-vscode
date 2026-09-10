# SCCharts Lab

> SCCharts for VS Code: diagrams, tick-by-tick simulation, and compiler diagnostics that
> link back to your model.

SCCharts Lab is an independent fork of [KIELER VS Code](https://github.com/kieler/vscode) by the
[KIELER project](https://rtsys.informatik.uni-kiel.de/kieler) at Kiel University. It bundles
a cut-down build of their language server with source-level diagnostics additions, plus a
rewritten diagram, simulation, and error experience on the client. It is not affiliated with or endorsed by
the KIELER project; report problems with this extension at
[Fallstop/kieler-vscode](https://github.com/Fallstop/kieler-vscode/issues), not to KIELER.
Both the original and this fork are licensed under the Eclipse Public License 2.0.

## Features

Adds language support for various languages that are part of the
[KIELER project](https://rtsys.informatik.uni-kiel.de/kieler).

-   Support for SCCharts
-   Support for Elk Graph
-   Support for KGraph
-   Support for Kieler Visualization
-   Support for Estrel
-   Support for Lustre

Diagram visualization and simulation are included in this extension. Open a model's
preview to simulate, step through ticks, edit inputs, and inspect its variable trace.
Everything lives in the editor area: there is no sidebar. The preview's toolbar carries
**Simulate**, the transport controls, **Stages** (browse the compiler's intermediate models)
and **Code** (generate C or Java). While a compiler stage is shown, **Model** brings the
diagram back to the SCChart.

Editing a model while its simulation runs marks the run as out of date: **Restart** becomes
**Rebuild**, which compiles the model again with the same simulation system and starts over
from tick 0. Unsaved edits are saved first.

Compilation failures appear above the diagram and in VS Code Problems. Scheduler
conflicts link to the participating source operations and explain their circular
ordering. C compiler errors link to generated code and to SCCharts when their origin
is known. Use **Technical details** for the original output or **View scheduler graph**
(**View compiler stage** for other failures) to inspect the failed transformation.
**Highlight in diagram** returns to the original SCCharts diagram and selects the
involved operations. Source links reuse the model's existing editor tab.

A **Potential instantaneous loop** warning comes from the compiler's loop analyzer: control
flow or a data dependency can return to the listed operations without crossing a tick
boundary. Timed transitions (`if elapsed >= t`) produce this warning on every cycle of
states, because the compiler tests each timeout in the tick its state is entered and the
analyzer cannot see that a clock reset on entry keeps the timeout from firing again. The
warning names the clock and the timed transitions; it is advisory as long as every state
on the loop resets the clock on entry and no timeout is 0. When the scheduler rejects the
model instead, its cycle error replaces the warning.

Source edits mark old diagnostics as stale until the next compilation. Compatible
fixed-size array assignments offer a **Copy array elements individually** quick fix
in the editor. Timing changes needed to resolve scheduler conflicts remain explicit
modeling decisions.

### Generate C and Java

Open an `.sctx` model and use the **Generate Code** icon in the editor title, the **Code**
button above the diagram preview, **SCCharts: Generate Code...** from the Command Palette,
or the file's Explorer context menu. Choose **C**, **Java**, or **C and Java**. Unsaved edits
to the source model are saved before compilation. **Compile current model with...** and a
code-producing system (for example *Netlist-based Compilation*) opens the same tabs instead of
drawing the code as a diagram.

Generated `.c`/`.h` and `.java` files open as read-only virtual documents. Generated files
are not written to your project until you save them. Use VS Code's **Save As...** or the
editor's **Save Generated File As...** action for one file. **Save All Generated Files...**
saves a target's complete set (including C headers) to a chosen folder and asks before
replacing existing files. Each generation opens separate previews; closing them discards
the unsaved output. Save files you want to keep before closing the window.

Generation errors appear in Problems. Models with C-only host
code cannot generate Java without matching Java implementations, and vice versa.
Failed, cancelled, or stale results never open as generated files. When generating both
targets, a successful target remains available if the other fails.

This command generates source using KIELER's netlist compiler. It does not invoke GCC
or `javac`; compiling and linking the saved output, including host libraries, belongs to
your application's build. The generated model exposes `reset` and `tick`; your application
initializes it, supplies inputs, calls `tick`, and reads outputs each reaction.

The bundled SCCharts Lab server is required for virtual code generation. An older or
external server that does not return generated files produces an explicit error.

## Requirements

SCCharts Lab is incompatible with the original **KIELER VS Code** extension
(`kieler.keith-vscode`): both register the same commands and languages and each
starts its own language server. SCCharts Lab refuses to activate while that extension is
enabled. Disable or uninstall it, then reload the window.

**Nothing else to install on Windows, macOS or Linux** when the extension comes from the
Marketplace or Open VSX: those builds are platform-specific and ship their own Java runtime, a
30 MB [jlink](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jlink.html) image of
Eclipse Temurin 21 with only the modules the language server uses. The universal `.vsix`
(GitHub releases, `yarn package`) carries no runtime and needs Java 21 or newer, found through
the `keith-vscode.javaHome` setting, `JDK_HOME`, `JAVA_HOME`, or `java` on PATH, in that order.
**SCCharts Lab: Show Java runtime and C compiler in use** tells you which one was picked.

C simulation compiles the generated program with a C compiler:

- **Windows**: the first C simulation offers to download [w64devkit](https://github.com/skeeto/w64devkit)
  (a portable GCC, 61 MB) into VS Code's storage folder for this extension; no installer, no
  PATH changes, removable with **SCCharts Lab: Remove downloaded C toolchain** and deleted when
  the extension is uninstalled. Windows on ARM
  runs the x64 toolchain through emulation. An existing MinGW or MSYS2 `gcc.exe` can be used
  instead through `keith-vscode.cCompilerPath`.
- **macOS**: install the Xcode Command Line Tools (`xcode-select --install`); their `gcc`
  command is Apple Clang and works.
- **Linux**: install `gcc` with your package manager (`sudo apt install build-essential`,
  `sudo dnf install gcc`, `sudo pacman -S gcc`).

Java simulation compiles with `javac`, which the bundled runtime does not include. Point
`keith-vscode.javaHome` at a JDK 21 or newer (or have one on PATH) to use it; C simulation does
not need this.

Diagrams use KIELER's light palette whatever the editor theme; set
`keith-vscode.diagramColorTheme` to `editor` to let dark themes switch to the dark palette.

Some transformed operations have no source provenance. Those diagnostics retain
their compiler stage or generated-file location instead of guessing a source line.

## Building from source

The language server is [sccharts-lite](../../kieler-server-fork): KIELER's SCCharts compiler,
simulation and KLighD diagram server, with this extension's diagnostics built in, compiled with
plain Maven from a checkout of the upstream sources and shaded into one 31 MB JAR. It is not
tracked in this repository. `yarn build:server` builds it (JDK 21 and Maven required; the
checkout is taken from `SCCHARTS_SERVER_SRC`, by default a sibling `kieler-server-fork`
directory) and places `server/sccharts-lite-server.jar`, or copies a prebuilt JAR given as
`SCCHARTS_SERVER_JAR`.

`yarn package` produces the universal `sccharts-lab.vsix`. `yarn package:platform
linux-x64` (any of `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`,
`win32-arm64`) first runs `scripts/build-jre.cjs`, which downloads the Temurin JDK pinned in
`server/runtime-manifest.json` for that platform (and for the build machine, since `jlink`
must match the target's `java.base` version), links `server/jre/` from the module list in the
manifest, and then packages `sccharts-lab-<target>.vsix` with it. `--pre-release` on either
command flags the package as a Marketplace pre-release. Any machine builds any target; downloads are cached in `out/runtime-cache/`. `node scripts/build-jre.cjs --refresh
jdk-21.0.x+y` moves the manifest to a newer Temurin release. `yarn build:jre` links the runtime
for the current machine, and `SCCHARTS_JAVA=server/jre/bin/java yarn test:server` runs the
server suites on it, which is how the module list is kept honest.

Releases are published by tagging `vX.Y.Z` (matching `package.json`) on GitHub; a `vX.Y.Z-pre`
tag publishes the same version as a pre-release (GitHub pre-release, Marketplace and Open VSX
pre-release channel). Either runs `.github/workflows/release.yml`: it builds the server, runs every check on the system JDK and on
the linked runtime (Linux and Windows, the latter with a downloaded w64devkit), packages all
seven `.vsix` files, attaches them to the GitHub release and publishes them to the Marketplace
and Open VSX. CI checks the server sources out of the repository named by the
`SCCHARTS_SERVER_REPO` variable.
