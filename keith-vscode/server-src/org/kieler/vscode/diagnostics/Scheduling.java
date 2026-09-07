package org.kieler.vscode.diagnostics;

import java.util.*;
import de.cau.cs.kieler.kicool.compilation.Processor;
import de.cau.cs.kieler.kexpressions.keffects.*;
import de.cau.cs.kieler.scg.*;

/** Extracts cycle witnesses from exactly the dependency kinds used by SimpleGuardScheduler. */
public final class Scheduling {
    private final Map<Node, List<Dependency>> outgoing = new IdentityHashMap<>();
    private final Map<Node, Integer> index = new IdentityHashMap<>(), low = new IdentityHashMap<>();
    private final Set<Node> active = Collections.newSetFromMap(new IdentityHashMap<>());
    private final Deque<Node> stack = new ArrayDeque<>();
    private final List<Set<Node>> components = new ArrayList<>();
    private int next;

    public static void analyze(Processor<?, ?> processor, SCGraph graph) {
        if (processor.getEnvironment().getErrors().getAllMessages().stream().noneMatch(m -> String.valueOf(m.getMessage()).contains("NOT asc-schedulable"))) return;
        Scheduling analysis = new Scheduling();
        for (Node node : graph.getNodes()) {
            List<Dependency> edges = new ArrayList<>();
            for (Link link : node.getOutgoingLinks()) {
                if (link instanceof ExpressionDependency || link instanceof ControlDependency ||
                    (link instanceof DataDependency && ((DataDependency) link).isConcurrent() && !((DataDependency) link).isConfluent())) {
                    if (link.getTarget() instanceof Node) edges.add((Dependency) link);
                }
            }
            analysis.outgoing.put(node, edges);
        }
        for (Node node : graph.getNodes()) if (!analysis.index.containsKey(node)) analysis.visit(node);
        for (Set<Node> component : analysis.components) {
            List<Dependency> witness = analysis.witness(component);
            if (witness.isEmpty()) continue;
            Issue issue = new Issue("scheduling-cycle", "Circular dependency prevents scheduling this tick.");
            issue.hint = "Give shared state one owner, separate request and acknowledgement, or deliberately read the previous tick's value. These choices change timing; review the intended behaviour.";
            for (Dependency dependency : witness) {
                Node from = (Node) dependency.eContainer(), to = (Node) dependency.getTarget();
                Issue.Edge edge = new Issue.Edge();
                edge.from = name(from); edge.to = name(to);
                edge.reason = dependency instanceof DataDependency ? reason((DataDependency) dependency) :
                    dependency instanceof ControlDependency ? "Control flow must execute in this order." : "The expression needs the earlier result.";
                for (Issue.Location location : SourceTrace.locations(processor, from)) SourceTrace.add(edge.locations, location);
                for (Issue.Location location : SourceTrace.locations(processor, to)) SourceTrace.add(edge.locations, location);
                edge.fromLabel = SourceTrace.locations(processor, from).stream().min(Comparator.comparingInt(l -> l.length)).map(l -> l.label).orElse(edge.from);
                edge.toLabel = SourceTrace.locations(processor, to).stream().min(Comparator.comparingInt(l -> l.length)).map(l -> l.label).orElse(edge.to);
                for (Issue.Location location : edge.locations) SourceTrace.add(issue.locations, location);
                issue.cycle.add(edge);
            }
            issue.details = component.size() + " generated operations are in this dependency cycle. Other unscheduled operations may be consequences of this conflict.";
            processor.getEnvironment().getErrors().add(null, issue.message, graph, issue);
        }
    }

    private static String name(Node node) {
        if (node instanceof de.cau.cs.kieler.scg.Assignment) {
            de.cau.cs.kieler.scg.Assignment a = (de.cau.cs.kieler.scg.Assignment) node;
            if (a.getReference() != null && a.getReference().getValuedObject() != null) return a.getReference().getValuedObject().getName();
        }
        return node.getName() == null ? node.eClass().getName() : node.getName();
    }

    private static String reason(DataDependency edge) {
        return edge.getType() == DataDependencyType.WRITE_READ ? "A concurrent read must follow the write it depends on." :
            edge.getType() == DataDependencyType.WRITE_WRITE ? "Concurrent writes require this ordering." : "Concurrent data accesses require this ordering (" + edge.getType() + ").";
    }

    private void visit(Node node) {
        index.put(node, next); low.put(node, next++); stack.push(node); active.add(node);
        for (Dependency edge : outgoing.getOrDefault(node, Collections.emptyList())) {
            Node to = (Node) edge.getTarget();
            if (!index.containsKey(to)) { visit(to); low.put(node, Math.min(low.get(node), low.get(to))); }
            else if (active.contains(to)) low.put(node, Math.min(low.get(node), index.get(to)));
        }
        if (low.get(node).equals(index.get(node))) {
            Set<Node> component = Collections.newSetFromMap(new IdentityHashMap<>());
            Node member;
            do { member = stack.pop(); active.remove(member); component.add(member); } while (member != node);
            if (component.size() > 1 || outgoing.getOrDefault(node, Collections.emptyList()).stream().anyMatch(e -> e.getTarget() == node)) components.add(component);
        }
    }

    private List<Dependency> witness(Set<Node> component) {
        for (Node node : component) {
            for (Dependency edge : outgoing.getOrDefault(node, Collections.emptyList())) {
                Node to = (Node) edge.getTarget();
                if (!component.contains(to)) continue;
                if (to == node) return Collections.singletonList(edge);
                for (Dependency back : outgoing.getOrDefault(to, Collections.emptyList())) {
                    if (back.getTarget() == node) return Arrays.asList(edge, back);
                }
            }
        }
        Node start = component.iterator().next();
        Deque<Node> queue = new ArrayDeque<>();
        Map<Node, Dependency> previous = new IdentityHashMap<>();
        queue.add(start);
        while (!queue.isEmpty()) {
            Node from = queue.remove();
            for (Dependency edge : outgoing.getOrDefault(from, Collections.emptyList())) {
                Node to = (Node) edge.getTarget();
                if (!component.contains(to)) continue;
                if (to == start) {
                    LinkedList<Dependency> result = new LinkedList<>(); result.add(edge);
                    for (Node n = from; n != start;) { Dependency p = previous.get(n); result.addFirst(p); n = (Node) p.eContainer(); }
                    return result;
                }
                if (!previous.containsKey(to)) { previous.put(to, edge); queue.add(to); }
            }
        }
        return Collections.emptyList();
    }
}
