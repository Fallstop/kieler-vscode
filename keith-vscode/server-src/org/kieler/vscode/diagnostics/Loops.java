package org.kieler.vscode.diagnostics;

import java.util.*;
import org.eclipse.emf.ecore.EObject;
import de.cau.cs.kieler.kexpressions.ValuedObjectReference;
import de.cau.cs.kieler.kexpressions.keffects.AssignOperator;
import de.cau.cs.kieler.kicool.compilation.Processor;
import de.cau.cs.kieler.kicool.environments.*;
import de.cau.cs.kieler.scg.Assignment;
import de.cau.cs.kieler.scg.Conditional;
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
        Timed timed = Timed.of(processor, loop);
        Issue issue = new Issue("instantaneous-loop", timed == null
            ? "A loop can run again within the same tick."
            : "Potential instantaneous loop through the timed transitions on " + timed.clockList() + ".");
        issue.severity = severity;
        issue.hint = timed == null
            ? "Control flow or a data dependency returns to one of these operations without passing a tick boundary. "
                + "Make one transition on the loop delayed instead of immediate, or read the previous tick's value with pre(). "
                + "When the model still schedules, the loop only spans a clock or variable that is reset and read in the same tick and this is advisory."
            : "The compiler tests each timeout in the tick its state is entered, so the loop analyzer sees a path through all of these "
                + "states that never waits for the next tick. This is advisory when every state on the loop resets " + timed.clockList()
                + " on entry (entry do " + timed.sourceName(timed.clocks.iterator().next()) + " = 0) and no timeout is 0: a clock that was just reset cannot reach "
                + "its timeout in the same tick. A state that does not reset the clock lets an already expired timeout carry the machine "
                + "through several states in one tick; reset the clock there or guard the transition with pre().";
        List<Issue.Location> locations = new ArrayList<>();
        for (Node node : loop) {
            for (Issue.Location location : SourceTrace.locations(processor, node)) {
                // On a timed loop the operations worth listing are the timed transitions and the clock resets; entry
                // actions that happen to lie on the path, such as output assignments, would only mislead.
                if (timed == null || timed.mentionsClock(location.label)) SourceTrace.add(locations, location);
            }
        }
        // Without the taken-transition tracing of the simulation systems the timed transitions carry no trace;
        // they are then found in the source model, which still names the clock as written.
        if (timed != null && locations.isEmpty()) for (Issue.Location location : timed.sourceTransitions(processor)) SourceTrace.add(locations, location);
        locations.sort(Comparator.comparingInt((Issue.Location location) -> location.offset));
        if (locations.size() > 12) locations = new ArrayList<>(locations.subList(0, 12));
        issue.locations.addAll(locations);
        issue.details = "Loop analyzer: " + MESSAGE + " " + loop.size() + " generated operations lie on this loop"
            + (locations.isEmpty() ? " and none carries a source location." : ".")
            + (timed == null ? "" : " The loop is control flow only (no data dependency) through the timed-automata expansion of "
                + timed.clockList() + " with " + timed.resets.size() + " reset(s) and " + timed.timeouts + " timeout check(s).");
        return issue;
    }

    /** A loop that runs through the timed-automata expansion: sleepT updates and timeout checks on one or more clocks. */
    private static final class Timed {
        final Set<String> clocks = new LinkedHashSet<>();
        final Set<Node> resets = new HashSet<>();
        int timeouts;

        /** Names as written in the model; region-local clocks are renamed during compilation. */
        final Map<String, String> sourceNames = new HashMap<>();

        static Timed of(Processor<?, ?> processor, Set<Node> loop) {
            Timed timed = new Timed();
            for (Node node : loop) {
                if (!(node instanceof Assignment)) continue;
                Assignment assignment = (Assignment) node;
                if (assignment.getReference() == null || assignment.getReference().getValuedObject() == null) continue;
                if ("sleepT".equals(assignment.getReference().getValuedObject().getName()) && assignment.getOperator() == AssignOperator.ASSIGNMIN) {
                    for (ValuedObjectReference reference : references(assignment.getExpression())) {
                        String name = reference.getValuedObject().getName();
                        if ("sleepT".equals(name)) continue;
                        timed.clocks.add(name);
                        for (Issue.Location origin : SourceTrace.locations(processor, reference.getValuedObject())) {
                            java.util.regex.Matcher declared = java.util.regex.Pattern.compile("^([A-Za-z_]\\w*)").matcher(origin.label);
                            if (declared.find()) { timed.sourceNames.put(name, declared.group(1)); break; }
                        }
                    }
                }
            }
            if (timed.clocks.isEmpty()) return null;
            for (Node node : loop) {
                if (node instanceof Assignment) {
                    Assignment assignment = (Assignment) node;
                    if (assignment.getReference() != null && assignment.getReference().getValuedObject() != null
                        && assignment.getOperator() == AssignOperator.ASSIGN
                        && timed.clocks.contains(assignment.getReference().getValuedObject().getName())) timed.resets.add(node);
                } else if (node instanceof Conditional) {
                    for (ValuedObjectReference reference : references(((Conditional) node).getCondition()))
                        if (timed.clocks.contains(reference.getValuedObject().getName())) { timed.timeouts++; break; }
                }
            }
            return timed;
        }

        String sourceName(String clock) { return sourceNames.getOrDefault(clock, clock); }

        /** Transitions and actions of the original model whose trigger reads one of the clocks. */
        List<Issue.Location> sourceTransitions(Processor<?, ?> processor) {
            List<Issue.Location> locations = new ArrayList<>();
            Object original = processor.getCompilationContext() == null ? null : processor.getCompilationContext().getOriginalModel();
            if (!(original instanceof EObject)) return locations;
            Set<String> names = new HashSet<>();
            for (String clock : clocks) names.add(sourceName(clock));
            for (Iterator<EObject> contents = ((EObject) original).eAllContents(); contents.hasNext();) {
                EObject object = contents.next();
                if (!(object instanceof de.cau.cs.kieler.sccharts.Action)) continue;
                for (ValuedObjectReference reference : references(((de.cau.cs.kieler.sccharts.Action) object).getTrigger())) {
                    EObject declaration = reference.getValuedObject().eContainer();
                    boolean clock = declaration instanceof de.cau.cs.kieler.kexpressions.VariableDeclaration
                        && ((de.cau.cs.kieler.kexpressions.VariableDeclaration) declaration).getType() == de.cau.cs.kieler.kexpressions.ValueType.CLOCK;
                    if (clock && names.contains(reference.getValuedObject().getName())) { SourceTrace.add(locations, SourceTrace.direct(object)); break; }
                }
            }
            return locations;
        }

        String clockList() {
            Set<String> names = new LinkedHashSet<>();
            for (String clock : clocks) names.add(sourceName(clock));
            return String.join(", ", names);
        }

        boolean mentionsClock(String label) {
            for (String clock : clocks) {
                for (String name : new String[] { clock, sourceName(clock) })
                    if (java.util.regex.Pattern.compile("\\b" + java.util.regex.Pattern.quote(name) + "\\b").matcher(label).find()) return true;
            }
            return false;
        }

        private static List<ValuedObjectReference> references(EObject expression) {
            List<ValuedObjectReference> references = new ArrayList<>();
            if (expression == null) return references;
            if (expression instanceof ValuedObjectReference && ((ValuedObjectReference) expression).getValuedObject() != null)
                references.add((ValuedObjectReference) expression);
            for (Iterator<EObject> contents = expression.eAllContents(); contents.hasNext();) {
                EObject child = contents.next();
                if (child instanceof ValuedObjectReference && ((ValuedObjectReference) child).getValuedObject() != null)
                    references.add((ValuedObjectReference) child);
            }
            return references;
        }
    }
}
