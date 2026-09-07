package org.kieler.vscode.diagnostics;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;
import de.cau.cs.kieler.kicool.compilation.*;

/** C model strings must outlive the JSON message that supplied them. */
public final class SimulationStrings {
    private static final Pattern ASSIGNMENT = Pattern.compile("(?m)^(\\s*)([^=\\r\\n]+?) = (item\\d*)->valuestring;$");

    public static void retain(CodeContainer container) {
        CodeFile template = container.get("c-simulation.ftl");
        if (template == null) throw new IllegalStateException("Missing C simulation template");
        String code = template.getCode();
        Matcher assignments = ASSIGNMENT.matcher(code);
        if (!assignments.find()) return;
        code = assignments.replaceAll("$1$2 = kieler_input_string((const void*) &$2, $3);");
        String marker = "void receiveVariables() {";
        if (!code.contains(marker)) throw new IllegalStateException("Unsupported C simulation template");
        try (InputStream input = SimulationStrings.class.getResourceAsStream("simulation-strings.c")) {
            if (input == null) throw new IllegalStateException("Missing string ownership helper");
            String helper = new String(input.readAllBytes(), StandardCharsets.UTF_8);
            container.add(template.getFileName(), code.replace(marker, helper + "\n" + marker));
        } catch (IOException error) { throw new UncheckedIOException(error); }
    }
}
