# Native launcher: jpackage and native-image for the language server

Status: assessment, 2026-09-11. "No Java install for users" is done since 0.8.0: every
platform VSIX carries a `jlink` image of Temurin 21 (`keith-vscode/server/jre`, 30 MB
compressed, 94 MB on disk) and the extension spawns `server/jre/bin/java -cp
server/sccharts-lite-server.jar ...`. This note records what the two remaining "native" options
would change, measured on the current jar and image on Linux x64.

## jpackage app-image

`jpackage --type app-image` wraps the same jar and jlink image behind a native launcher
binary. Nothing is compiled ahead of time: the launcher reads `lib/app/sccharts-server.cfg`,
loads `lib/runtime/lib/server/libjvm.so` and starts the same main class.

```sh
# from keith-vscode, after yarn build:server and node scripts/build-jre.cjs --target <t>
mkdir -p out/jpackage-in && cp server/sccharts-lite-server.jar out/jpackage-in/
jpackage --type app-image --name sccharts-server \
  --input out/jpackage-in --main-jar sccharts-lite-server.jar \
  --main-class de.cau.cs.kieler.language.server.LanguageServer \
  --runtime-image server/jre \
  --java-options "-Djava.awt.headless=true" \
  --dest out/jpackage
# result: out/jpackage/sccharts-server/{bin/sccharts-server, lib/app/*.jar, lib/app/*.cfg, lib/runtime/**}
```

Measured (Temurin/OpenJDK 21.0.11 `jpackage`, 0.4 s):

| layout | bytes on disk |
|---|---|
| `server/jre` (jlink image) | 94,283,381 |
| `server/sccharts-lite-server.jar` | 31,271,080 |
| current layout, total | 125,554,461 |
| `jpackage` app-image (image + jar + launcher) | 126,115,746 |
| delta | +561,285 (launcher 21.9 kB, `libapplauncher.so` 214 kB, icon, cfg, rounding) |

The launcher answered `initialize` over stdio unchanged (same capabilities JSON), so the
extension could spawn `bin/sccharts-server` instead of `java`.

What it adds over the jlink layout:

- A process named `sccharts-server` instead of `java` in task managers and `ps`.
- One launcher per platform: `.exe` on Windows, an `.app` bundle on macOS (`--type app-image`
  produces `sccharts-server.app/Contents/{MacOS,app,runtime}`), a directory on Linux. jpackage
  cannot cross-build: each of the six images has to be produced on its own OS and
  architecture (the current release job links all six runtimes on one Linux runner).
- Code-signing surfaces. macOS Gatekeeper treats the launcher and every dylib in the bundle as
  code to notarise; Windows SmartScreen reputation attaches to the `.exe`. Today the VSIX
  contains only `java` from Temurin, which Adoptium signs and notarises. A jpackage bundle
  would need an Apple Developer ID and an Authenticode certificate in CI, or users on macOS get
  the "cannot be opened" dialog for an unsigned binary launched by VS Code.
- JVM options are baked into the `.cfg` at build time. The AppCDS options the extension passes
  per start (`-XX:SharedArchiveFile=<user's global storage>/...`) would have to be written into
  that file or passed through `JAVA_TOOL_OPTIONS`, which the JVM echoes on stderr on every start.

What it does not change: startup time (same JVM, same jar, same class loading), memory, or
the module list.

## GraalVM native-image

A single static binary per platform, sub-second start, half the memory. Blockers, all in the
server's dependencies rather than in KIELER's own code:

- **Guice**: every injector (Xtext's per-language injectors, KiCool's `TracingIntegration`
  injector, KLighD's) resolves bindings by reflection and generates proxies for JIT-bound
  singletons. Reachability metadata must list every injected constructor, field and method;
  Guice's `Provider` proxies need `--enable-url-protocols` and the dynamic-proxy metadata.
- **EMF**: `EPackage.Registry` populates itself through `Class.forName` on the generated
  `*PackageImpl`; `EcoreUtil` and the Xtext serializer walk `EClass` features reflectively;
  `ResourceSet` factories are looked up by extension through `Resource.Factory.Registry`.
- **Xtext**: parsers are generated classes but the `IGrammarAccess` instances, the
  `ITransientValueService` and every `Abstract*RuntimeModule` bind by string class names;
  `ServiceLoader` (used by `KielerServiceLoader` for `ISystemProvider`, `IProcessorProvider`,
  `SynthesisHook`, `ILanguageServerContribution`) must be pre-registered.
- **lsp4j**: the JSON-RPC layer reflects over `@JsonRequest`/`@JsonNotification` interfaces
  and Gson serialises message classes reflectively.
- **AWT**: KLighD measures text with `java.awt.Font` (`java.desktop`); native-image supports
  AWT on Linux only and behind a large substitution layer.
- **KiCool systems** are `.kico` resources loaded at runtime from the classpath, and the
  processors they name are instantiated by id from the Guice injector.

The approach that would work: run the server under the tracing agent
(`-agentlib:native-image-agent=config-output-dir=...`) through the whole extension test
suite (`yarn test:server` exercises parsing, every diagram synthesis, C and Java code
generation and simulation), commit the resulting `reflect-config.json`,
`proxy-config.json`, `resource-config.json`, `serialization-config.json` and
`jni-config.json` next to the fork's `server/` module, and build with
`--no-fallback -H:+ReportExceptionStackTraces`. Every new processor, synthesis or language
then needs a re-run of the agent, and every gap shows up as a runtime
`ClassNotFoundException` rather than at build time. Expect a multi-week effort and a build
that needs GraalVM on all six targets (no cross-compilation).

## Recommendation

Keep the jlink layout. jpackage buys a process name for +0.6 MB and costs six OS-specific
build jobs plus signing; native-image is a research project because of Guice, EMF and AWT
reflection. Startup is addressed where it actually is, in class loading: the AppCDS archive
built on the user's machine (`keith-vscode/src/runtime/startup-cache.ts`) cuts `initialize`
by about a third without changing the package.
