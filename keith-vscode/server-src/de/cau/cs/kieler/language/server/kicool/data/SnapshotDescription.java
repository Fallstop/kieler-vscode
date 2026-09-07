package de.cau.cs.kieler.language.server.kicool.data;

import java.util.*;
import org.eclipse.emf.ecore.EObject;
import de.cau.cs.kieler.kicool.environments.*;
import org.kieler.vscode.diagnostics.*;

/** Compatible with the bundled DTO; adds structured diagnostics without removing raw messages. */
public class SnapshotDescription {
    private String name;
    private int index, snapshotIndex;
    private List<String> errors = new ArrayList<>(), warnings = new ArrayList<>(), infos = new ArrayList<>();
    public List<Issue> diagnostics = new ArrayList<>();

    public SnapshotDescription(String name, int index, int snapshotIndex, Errors errors, Warnings warnings, Infos infos) {
        this.name = name; this.index = index; this.snapshotIndex = snapshotIndex;
        copy(errors, this.errors, "error"); copy(warnings, this.warnings, "warning"); copy(infos, this.infos, "info");
    }

    private void copy(MessageObjectReferences messages, List<String> text, String severity) {
        if (messages == null) return;
        boolean structured = messages.getAllMessages().stream().anyMatch(m -> m.getPayload() instanceof Issue);
        for (MessageObjectLink message : messages.getAllRootMessages()) {
            String raw = String.valueOf(message.getMessage());
            if (message.getException() != null) {
                raw += "\n" + message.getException();
                for (StackTraceElement frame : message.getException().getStackTrace()) raw += "\n\t" + frame;
            }
            text.add(raw);
            if (message.getPayload() instanceof Issue) diagnostics.add((Issue) message.getPayload());
            else if (!structured && !severity.equals("info")) {
                Issue issue = new Issue("compiler", String.valueOf(message.getMessage()));
                issue.severity = severity; issue.details = raw;
                if (message.getObject() instanceof EObject) SourceTrace.add(issue.locations, SourceTrace.direct((EObject) message.getObject()));
                diagnostics.add(issue);
            }
        }
    }
    public String getName() { return name; }
    public void setName(String value) { name = value; }
    public int getIndex() { return index; }
    public void setIndex(int value) { index = value; }
    public int getSnapshotIndex() { return snapshotIndex; }
    public void setSnapshotIndex(int value) { snapshotIndex = value; }
    public List<String> getErrors() { return errors; }
    public void setErrors(List<String> value) { errors = value; }
    public List<String> getWarnings() { return warnings; }
    public void setWarnings(List<String> value) { warnings = value; }
    public List<String> getInfos() { return infos; }
    public void setInfos(List<String> value) { infos = value; }
}
