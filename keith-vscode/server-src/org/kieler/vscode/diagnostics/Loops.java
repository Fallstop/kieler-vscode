package org.kieler.vscode.diagnostics;

import java.util.*;
import de.cau.cs.kieler.kicool.compilation.Processor;
import de.cau.cs.kieler.kicool.environments.*;
import de.cau.cs.kieler.scg.Node;
import de.cau.cs.kieler.scg.processors.analyzer.*;

/** Gives the loop analyzer's bare "Instantaneous loop detected!" message source locations and an explanation. */
public final class Loops {
    static final String MESSAGE = "Instantaneous loop detected!";

    public static void analyze(Processor<?, ?> processor) {
        Environment environment = processor.getEnvironment();
        LoopData data = environment.getProperty(LoopAnalyzerV2.LOOP_DATA);
        if (data == null) return;
        List<Set<Node>> loops = new ArrayList<>();
        for (SingleLoop loop : data.getLoops()) if (!loop.getCriticalNodes().isEmpty()) loops.add(loop.getCriticalNodes());
        if (loops.isEmpty() && !data.getCriticalNodes().isEmpty()) loops.add(data.getCriticalNodes());
        if (loops.isEmpty()) return;
        attach(processor, environment.getErrors(), "error", loops);
        attach(processor, environment.getWarnings(), "warning", loops);
        attach(processor, environment.getInfos(), "info", loops);
    }

    private static void attach(Processor<?, ?> processor, MessageObjectReferences messages, String severity, List<Set<Node>> loops) {
        if (messages == null) return;
        List<MessageObjectLink> bare = new ArrayList<>();
        for (MessageObjectLink message : messages.getAllRootMessages()) {
            if (MESSAGE.equals(message.getMessage()) && message.getPayload() == null) bare.add(message);
        }
        if (bare.isEmpty()) return;
        List<Issue> issues = new ArrayList<>();
        for (Set<Node> loop : loops) issues.add(issue(processor, severity, loop));
        // The analyzer reports once per environment; every further loop becomes its own message.
        bare.get(0).setPayload(issues.get(0));
        for (MessageObjectLink extra : bare.subList(1, bare.size())) extra.setPayload(Issue.SUPPRESSED);
        for (Issue issue : issues.subList(1, issues.size())) messages.add(null, issue.message, null, issue);
    }

    private static Issue issue(Processor<?, ?> processor, String severity, Set<Node> loop) {
        Issue issue = new Issue("instantaneous-loop", "A loop can run again within the same tick.");
        issue.severity = severity;
        issue.hint = "Control flow or a data dependency returns to one of these operations without passing a tick boundary. "
            + "Make one transition on the loop delayed instead of immediate, or read the previous tick's value with pre(). "
            + "When the model still schedules, the loop only spans a clock or variable that is reset and read in the same tick and this is advisory.";
        List<Issue.Location> locations = new ArrayList<>();
        for (Node node : loop) for (Issue.Location location : SourceTrace.locations(processor, node)) SourceTrace.add(locations, location);
        locations.sort(Comparator.comparingInt((Issue.Location location) -> location.offset));
        if (locations.size() > 12) locations = new ArrayList<>(locations.subList(0, 12));
        issue.locations.addAll(locations);
        issue.details = "Loop analyzer: " + MESSAGE + " " + loop.size() + " generated operations lie on this loop"
            + (locations.isEmpty() ? " and none carries a source location." : ".");
        return issue;
    }
}
