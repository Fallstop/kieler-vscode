package de.cau.cs.kieler.language.server.kicool.data;

import java.util.*;
import org.kieler.vscode.diagnostics.GeneratedCode;

/** Keeps the existing stage protocol and adds source files only to successful final results. */
public class CompilationResults {
    public List<List<SnapshotDescription>> files;
    public List<GeneratedCode.File> generatedFiles;
    public String generationError;

    public CompilationResults(List<List<SnapshotDescription>> files) {
        this.files = files;
    }

    public CompilationResults(List<List<SnapshotDescription>> files, List<?> models, boolean finished, String uri) {
        this(files);
        if (finished) GeneratedCode.collect(this, models, uri);
    }
}
