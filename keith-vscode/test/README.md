Run the regression suite from `keith-vscode` with `npm test` (Node 18 or newer).
It covers simulation sequencing and failures, compiler progress, numeric input,
and DOM interactions using the existing TypeScript sources and a mocked VS Code host.

Run `npm run test:server` to exercise the bundled Java language server with the
small SCCharts fixture: compile, start, change boolean and uninitialized string inputs, step, stop, and restart.
This check requires `java` and the bundled server JAR and Jetty libraries.
Set `KIELER_SERVER_DIR` to use server libraries from another checkout.

Build and check the extension with `npm run build`, `npm run lint`, and:

```sh
../node_modules/.bin/tsc --noEmit -p tsconfig.json
../node_modules/.bin/tsc --noEmit -p tsconfig.webview.json
```
