Run the regression suite from `keith-vscode` with `npm test` (Node 18 or newer).
It covers simulation sequencing and failures, compiler progress, numeric input,
and DOM interactions using the existing TypeScript sources and a mocked VS Code host.

Run `npm run test:server` to exercise the bundled Java language server with the
small SCCharts fixture: compile, start, change boolean and uninitialized string
inputs, step, stop, and restart.
It also checks the full broken demo's scheduler cycle and exact source ranges,
the subsequent C array error and working element-copy quick fix, embedded C errors,
and recovery after failures. It requires Java 21, `gcc`, and `server/sccharts-lite-server.jar`
(`npm run build:server`). Set `SCCHARTS_SERVER_DIR` to a directory holding another
`sccharts-lite-server.jar` to test a different build, and `SCCHARTS_JAVA` to the launcher the
server should run on; `npm run build:jre` followed by
`SCCHARTS_JAVA=server/jre/bin/java npm run test:server` exercises the bundled runtime image
with exactly the modules that ship in the platform packages.

The server suite also generates C and Java through the real protocol, checks that source
files stay in memory, compiles exported fixtures with GCC and `javac`, and exercises invalid
input, incompatible host code, scheduler failure and recovery. Run `node test/server-codegen.cjs`
for just these checks. Client tests cover virtual preview lifetime,
Save As, grouped export, overwrite protection, save errors, cancellation and stale builds.

Client tests cover diagnostic invalidation during edits, cancellation, restart,
file switching, source mapping, diagram trace selection, and the error panel.

Build and check the extension with `npm run build`, `npm run lint`, and:

```sh
../node_modules/.bin/tsc --noEmit -p tsconfig.json
../node_modules/.bin/tsc --noEmit -p tsconfig.webview.json
```
