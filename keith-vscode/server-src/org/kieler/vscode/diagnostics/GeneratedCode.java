package org.kieler.vscode.diagnostics;

import java.util.*;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.xtext.resource.XtextResourceSet;
import org.eclipse.xtext.validation.CheckMode;
import org.eclipse.xtext.validation.IResourceValidator;
import org.eclipse.xtext.util.CancelIndicator;
import de.cau.cs.kieler.annotations.*;
import de.cau.cs.kieler.kicool.compilation.*;
import de.cau.cs.kieler.language.server.kicool.data.CompilationResults;
import de.cau.cs.kieler.sccharts.text.SCTXStandaloneSetup;

public final class GeneratedCode {
    public static final class File {
        public final String fileName, code;
        File(String fileName, String code) { this.fileName = fileName; this.code = code; }
    }

    public static void collect(CompilationResults result, List<?> models, String uri) {
        if (result.files == null || models == null || models.isEmpty()) return;
        if (result.files.stream().flatMap(List::stream).anyMatch(s -> !s.getErrors().isEmpty())) return;
        Object last = models.get(models.size() - 1);
        if (!(last instanceof CodeContainer)) return;
        CodeContainer container = (CodeContainer) last;
        // Deployment containers may contain executables, libraries or simulation wrappers.
        if (container.getFiles().isEmpty() || container.getFiles().stream().anyMatch(f -> f.isProxy()
            || !f.getFileName().matches(".*\\.(c|h|java)"))) return;
        try {
            String target = container.getFiles().stream().anyMatch(f -> f instanceof JavaCodeFile) ? "java" : "c";
            validate(uri, target);
            List<File> files = new ArrayList<>();
            for (CodeFile file : container.getFiles()) files.add(new File(file.getFileName(), file.getCode()));
            result.generatedFiles = files;
        } catch (Exception error) {
            result.generationError = error.getMessage() == null ? error.toString() : error.getMessage();
            Issue issue = error instanceof InvalidSource ? ((InvalidSource) error).issue
                : new Issue("code-generation", result.generationError);
            // The final snapshot is the code container; use its existing stage for Problems and navigation.
            var stages = result.files.get(result.files.size() - 1);
            var stage = stages.get(stages.size() - 1);
            stage.getErrors().add(result.generationError);
            stage.diagnostics.add(issue);
        }
    }

    private static void validate(String uri, String target) {
        if (!"sctx".equals(URI.createURI(uri).fileExtension())) return;
        // The compiler loads from disk and can recover an AST from invalid input. Never export that recovery.
        var injector = SCTXStandaloneSetup.doSetup();
        var resources = injector.getInstance(XtextResourceSet.class);
        var resource = resources.getResource(URI.createURI(uri), true);
        var issues = injector.getInstance(IResourceValidator.class).validate(resource, CheckMode.ALL, CancelIndicator.NullImpl);
        for (var issue : issues) {
            if (issue.getSeverity() == org.eclipse.xtext.diagnostics.Severity.ERROR) {
                Issue diagnostic = new Issue("code-generation", "Cannot generate code: " + issue.getMessage()
                    + (issue.getLineNumber() == null ? "" : " (line " + issue.getLineNumber() + ")") + ". See Problems for source errors.");
                diagnostic.locations.add(new Issue.Location(uri, issue.getOffset() == null ? 0 : issue.getOffset(),
                    issue.getLength() == null ? 0 : issue.getLength(), issue.getMessage()));
                throw new InvalidSource(diagnostic);
            }
        }
        String other = target.equals("java") ? "c" : "java";
        for (var loaded : new ArrayList<>(resources.getResources())) {
            var contents = loaded.getAllContents();
            while (contents.hasNext()) {
                EObject object = contents.next();
                if (object instanceof Pragmatable) {
                    var pragmas = ((Pragmatable) object).getPragmas();
                    if (pragmas.stream().anyMatch(p -> p.getName().equals("hostcode-" + other))
                        && pragmas.stream().noneMatch(p -> p.getName().equals("hostcode-" + target))) {
                        throw incompatible(target, "#hostcode-" + other, "#hostcode-" + target,
                            pragmas.stream().filter(p -> p.getName().equals("hostcode-" + other)).findFirst().get());
                    }
                }
                if (object instanceof Annotatable) {
                    var annotations = ((Annotatable) object).getAnnotations();
                    if (annotations.stream().anyMatch(a -> a.getName().equalsIgnoreCase(other))
                        && annotations.stream().noneMatch(a -> a.getName().equalsIgnoreCase(target))) {
                        throw incompatible(target, other.equals("c") ? "@C" : "@Java", target.equals("c") ? "@C" : "@Java", object);
                    }
                }
            }
        }
    }

    private static InvalidSource incompatible(String target, String found, String required, EObject object) {
        Issue issue = new Issue("code-generation", "Cannot generate " + (target.equals("java") ? "Java" : "C")
            + ": this model uses " + found + " without a " + required
            + " equivalent. Choose the model's host language or supply the matching host implementation.");
        SourceTrace.add(issue.locations, SourceTrace.direct(object));
        return new InvalidSource(issue);
    }

    private static final class InvalidSource extends IllegalArgumentException {
        final Issue issue;
        InvalidSource(Issue issue) { super(issue.message); this.issue = issue; }
    }
}
