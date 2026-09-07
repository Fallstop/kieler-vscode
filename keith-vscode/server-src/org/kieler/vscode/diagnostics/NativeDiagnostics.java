package org.kieler.vscode.diagnostics;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.regex.*;
import de.cau.cs.kieler.kicool.compilation.Processor;
import de.cau.cs.kieler.kicool.deploy.Logger;

public final class NativeDiagnostics {
    private static final Pattern DIAGNOSTIC = Pattern.compile("^(.+?):(\\d+)(?::(\\d+))?:\\s*(fatal error|error|warning|note):\\s*(.*)$");

    public static void collect(Integer status, Processor<?, ?> processor, List<String> command, File directory, Logger logger) throws Exception {
        String log = logger.intermediateLog("diagnostics").getFiles().get(0).getCode().replaceAll("\u001b\\[[0-9;]*m", "");
        Issue previous = null;
        int errors = 0;
        for (String line : log.split("\\r?\\n")) {
            Matcher match = DIAGNOSTIC.matcher(line);
            if (!match.matches()) continue;
            File file = new File(match.group(1));
            if (!file.isAbsolute()) file = new File(directory, match.group(1));
            Issue.Location location = new Issue.Location(file.toURI().toString(), 0, 1, match.group(5));
            location.line = Integer.parseInt(match.group(2)) - 1;
            location.column = match.group(3) == null ? 0 : Integer.parseInt(match.group(3)) - 1;
            if (file.isFile() && file.length() < 5000000) {
                List<String> lines = Files.readAllLines(file.toPath(), StandardCharsets.UTF_8);
                if (location.line >= 0 && location.line < lines.size()) location.generatedLine = lines.get(location.line);
            }
            if (match.group(4).equals("note") && previous != null) { previous.locations.add(location); continue; }
            Issue issue = new Issue("c-compiler", match.group(5));
            issue.severity = match.group(4).equals("warning") ? "warning" : "error";
            issue.locations.addAll(GeneratedTrace.get(processor.getCompilationContext(), location.generatedLine));
            issue.locations.add(location);
            issue.details = "Command: " + String.join(" ", command) + "\nWorking directory: " + directory + "\n\n" + log;
            if (issue.message.contains("array type") && (issue.message.contains("not assignable") || issue.message.contains("assignment to expression"))) issue.hint = "C arrays cannot be assigned as a whole. Copy individual elements, or use an appropriate host C copy with the correct size.";
            if (issue.severity.equals("error")) errors++;
            (issue.severity.equals("warning") ? processor.getEnvironment().getWarnings() : processor.getEnvironment().getErrors()).add(null, issue.message, null, issue);
            previous = issue;
        }
        if ((status == null || status != 0) && errors == 0) {
            boolean missing = log.contains("Cannot run program") || log.contains("No such file or directory") || log.contains("CreateProcess error=2");
            Issue issue = new Issue(missing ? "c-toolchain" : "c-build", missing ? "The C compiler could not be started." : "The C build failed" + (status == null ? "." : " (exit " + status + ")."));
            issue.hint = missing ? "Check that " + command.get(0) + " is installed and available on the language server's PATH." : "Inspect the compiler and linker output below for the first reported failure.";
            issue.details = log;
            processor.getEnvironment().getErrors().add(null, issue.message, null, issue);
        }
    }
}
