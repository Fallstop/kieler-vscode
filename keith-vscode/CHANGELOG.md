# Change Log

All notable changes to the "keith-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Serialize simulation ticks, retain inputs edited during a tick, and cancel obsolete run loops on pause or restart.
- Guard startup and shutdown, retain the correct model on restart, and ignore late simulation replies.
- Keep toolbar controls focused during live ticks; validate numeric and array inputs and refresh hidden previews on return.
- Keep transport controls accessible in narrow panels, correct tick summaries, and wait for browser visualization startup.
- Dispose diagram message handlers when panels close; safely cache verification results before its view opens.

- The diagram preview tab ("[Preview] model.sctx") now carries the simulation: Restart / Step / Run / Stop,
  the tick counter and speed live above the diagram, and a resizable trace drawer below it shows every
  variable per tick (inputs editable in the "Next" column) with a plain-language summary of each tick.
  Hints explain what ticks, inputs and outputs mean; Space steps, R runs/pauses.
- Number format switch (decimal / hex / binary / char) for values shown in the trace and typed into inputs.
- The KIELER Simulation sidebar view still works but is no longer revealed automatically.
- Initial release
