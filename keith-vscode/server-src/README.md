# Compiler diagnostic patch

`npm run build:server` compiles these Java 11 sources against the bundled
`server/kieler-language-server.jar` and writes `server/diagnostics.jar`.
The extension puts that small JAR first on the classpath, ahead of the existing
Jetty compatibility libraries and the unchanged language server. End users need
only Java; building requires a JDK. A client-only checkout can still build without
the untracked server JAR and uses legacy-message fallback diagnostics.

`BuildPatch` uses the ASM already bundled in KIELER to add the hooks below. It checks
each target method signature and fails the build if a server update changes it:

- Begin compilation: capture original Xtext ranges and stop on compiler errors.
- EMF copies and explicit transformation trace calls: carry original ranges into
  transformed objects, using weak keys so model objects can be collected.
- Scheduler completion: compute strongly connected components over the same
  dependency types used by the scheduler and return a short cycle witness.
- Native compiler return: preserve actual file/line/column diagnostics and logs.
- C assignment emission: associate emitted fragments with their original model ranges.
- C simulation template: retain incoming strings beyond their JSON message's lifetime.
  Equal strings are reused per model slot; distinct values stay alive until simulation
  exit because other model variables or host C can retain their pointers across ticks.
- Loop analyzer completion: attach the critical nodes' source locations and an explanation
  to the bare "Instantaneous loop detected!" message.
- Diagram generation: publish KLighD's existing source associations as trace links.
- Diagram refresh: skip queued updates whose view context has already been closed.
- Main-thread hand-off: callers that queue work for KLighD's main thread waited on one shared
  notify() until the whole queue drained. With overlapping diagram requests a wake-up could go
  to the wrong caller and the server stalled with every thread waiting. Each caller now waits
  on its own completion flag and the main loop wakes all waiters.
- Diagram concurrency: the bundled server held the diagram-state lock while it waited for
  KLighD's main thread, which the queued layout step also locks, so overlapping show or
  model requests deadlocked; it also let a synthesis rebuild the view model while another
  request traversed it, which failed with detached nodes. The patch drops that lock around
  `prepareModel`, serializes `prepareModel` and `createModel` with one model lock instead,
  reads a node's parent once, and lets a superseded request skip its layout step.

`SnapshotDescription` retains the existing DTO methods and raw messages, and adds
structured diagnostics. This is an additive protocol change. The patch does not
change scheduling rules or automatically repair model semantics. The simulation
wrapper owns incoming strings to prevent dangling pointers; generated model C is unchanged.
It does stop compilation after errors instead of emitting an incomplete executable.

The bundled experimental tracing engine fails on the demo's Surface/Depth pass.
These hooks observe copies and explicit origins without enabling that engine or
guessing origins from variable names. Some generated objects have no explicit
origin. In that case the UI retains a compiler-stage/generated-file diagnostic.
Generated C assignments retain their original model locations. Embedded C is mapped
through decoded string offsets; a unique simple array copy can also be matched to
source. Unmapped expressions remain linked to generated C.

Run `npm run test:server` for real-server coverage, including the full broken demo,
the resulting array error, embedded C errors, and recovery to a working simulation.
The upstream code and bundled classes use EPL-2.0; see the extension LICENSE.
