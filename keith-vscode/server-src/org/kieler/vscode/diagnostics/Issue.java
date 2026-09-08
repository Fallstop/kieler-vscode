package org.kieler.vscode.diagnostics;

import java.util.*;

/** JSON payload shared with the extension. Offsets are UTF-16, like Xtext and VS Code. */
public final class Issue {
    /** Payload marking a raw compiler message that a structured issue already explains. */
    public static final Object SUPPRESSED = new Object();

    public String code;
    public String message;
    public String severity = "error";
    public String hint;
    public String details;
    public List<Location> locations = new ArrayList<>();
    public List<Edge> cycle = new ArrayList<>();

    public Issue(String code, String message) { this.code = code; this.message = message; }

    public static final class Location {
        public String uri;
        public int offset;
        public int length;
        public String label;
        public int line = -1;
        public int column = -1;
        public String generatedLine;
        public List<String> traceUris = new ArrayList<>();
        public Location(String uri, int offset, int length, String label) {
            this.uri = uri; this.offset = offset; this.length = length; this.label = label;
        }
    }

    public static final class Edge {
        public String from;
        public String to;
        public String reason;
        public String fromLabel;
        public String toLabel;
        public List<Location> locations = new ArrayList<>();
    }
}
