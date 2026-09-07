# KIELER for Visual Studio Code

> This extension brings the KIELER project to VS Code!

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

Source edits mark old diagnostics as stale until the next compilation. Compatible
fixed-size array assignments offer a **Copy array elements individually** quick fix
in the editor. Timing changes needed to resolve scheduler conflicts remain explicit
modeling decisions.

## Requirements

This extension requires Java 11 or newer on your PATH. C simulation also requires
`gcc` on the language server's PATH (Apple Clang's `gcc` command works on macOS).

Some transformed operations have no source provenance. Those diagnostics retain
their compiler stage or generated-file location instead of guessing a source line.
