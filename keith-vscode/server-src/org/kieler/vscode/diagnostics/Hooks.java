package org.kieler.vscode.diagnostics;

import java.io.File;
import java.util.*;
import de.cau.cs.kieler.kicool.compilation.*;
import de.cau.cs.kieler.kicool.deploy.Logger;
import de.cau.cs.kieler.scg.SCGraph;

public final class Hooks {
    public static void begin(CompilationContext context) {
        GeneratedTrace.begin(context);
        SourceTrace.begin(context.getOriginalModel());
        // Code generated after a failed scheduler is incomplete and must never be deployed.
        context.setStopOnError(true);
    }

    public static void scheduled(Processor<?, ?> processor, SCGraph graph) {
        try { Scheduling.analyze(processor, graph); }
        catch (Exception error) { System.err.println("KIELER diagnostic tracing: " + error); }
    }

    public static void nativeResult(Integer status, Processor<?, ?> processor, List<String> command, File directory, Logger logger) {
        if (!processor.getId().equals("de.cau.cs.kieler.kicool.deploy.compiler.c")) return;
        try { NativeDiagnostics.collect(status, processor, command, directory, logger); }
        catch (Exception error) { System.err.println("KIELER C diagnostics: " + error); }
    }
}
