# SCCharts Lab

> SCCharts for VS Code: diagrams, tick-by-tick simulation, and compiler diagnostics that
> link back to your model.

SCCharts Lab is an independent fork of [KIELER VS Code](https://github.com/kieler/vscode) by the
[KIELER project](https://rtsys.informatik.uni-kiel.de/kieler) at Kiel University. It bundles
their unmodified language server and adds a small runtime patch for diagnostics, plus a rewritten
diagram, simulation, and error experience on the client. It is not affiliated with or endorsed by
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

Compilation failures appear above the diagram and in VS Code Problems. Scheduler
conflicts link to the participating source operations and explain their circular
ordering. C compiler errors link to generated code and to SCCharts when their origin
is known. Use **Technical details** for the original output or **View scheduler graph**
(**View compiler stage** for other failures) to inspect the failed transformation.
**Highlight in diagram** returns to the original SCCharts diagram and selects the
involved operations. Source links reuse the model's existing editor tab.

A **Potential instantaneous loop** warning comes from the compiler's loop analyzer: control
flow or a data dependency can return to the listed operations without crossing a tick
boundary. When the model still compiles, the loop usually spans a clock or variable that
every transition of a cycle resets, and the warning is advisory. When the scheduler rejects
the model instead, its cycle error replaces the warning.

Source edits mark old diagnostics as stale until the next compilation. Compatible
fixed-size array assignments offer a **Copy array elements individually** quick fix
in the editor. Timing changes needed to resolve scheduler conflicts remain explicit
modeling decisions.

## Requirements

SCCharts Lab is incompatible with the original **KIELER VS Code** extension
(`kieler.keith-vscode`): both register the same commands, languages and views and each
starts its own language server. SCCharts Lab refuses to activate while that extension is
enabled. Disable or uninstall it, then reload the window.

This extension requires Java 11 or newer on your PATH. C simulation also requires
`gcc` on the language server's PATH (Apple Clang's `gcc` command works on macOS).

Some transformed operations have no source provenance. Those diagnostics retain
their compiler stage or generated-file location instead of guessing a source line.

## Building from source

The language server and its Jetty libraries are not tracked in git. `yarn fetch-server`
downloads them from the upstream Marketplace release and Maven Central and verifies them
against `server/manifest.json`. Building the diagnostic patch needs a JDK 11 or newer;
`yarn package` then produces `sccharts-lab.vsix`. Releases are published by tagging `vX.Y.Z`
(matching `package.json`) on GitHub, which runs `.github/workflows/release.yml`.
