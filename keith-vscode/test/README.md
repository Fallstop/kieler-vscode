Run the regression suite from `keith-vscode` with `npm test` (Node 18 or newer).
It covers simulation sequencing and failures, compiler progress, numeric input,
and DOM interactions using the existing TypeScript sources and a mocked VS Code host.

Run `npm run test:server` to exercise the bundled Java language server with the
small SCCharts fixture: compile, start, change inputs, step, stop, and restart.
It also checks the full broken demo's scheduler cycle and exact source ranges,
the subsequent C array error and working element-copy quick fix, embedded C errors,
and recovery after failures. This check builds the diagnostic patch and requires a
JDK 11 or newer, `gcc`, and the bundled server JAR and Jetty libraries.

Client tests cover diagnostic invalidation during edits, cancellation, restart,
file switching, source mapping, diagram trace selection, and the error panel.

Build and check the extension with `npm run build`, `npm run lint`, and:

```sh
../node_modules/.bin/tsc --noEmit -p tsconfig.json
../node_modules/.bin/tsc --noEmit -p tsconfig.webview.json
```
