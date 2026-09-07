package org.kieler.vscode.diagnostics;

import java.util.*;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.xtext.nodemodel.INode;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;
import de.cau.cs.kieler.kicool.compilation.Processor;

public final class SourceTrace {
    private static final Map<EObject, List<Issue.Location>> origins = Collections.synchronizedMap(new WeakHashMap<>());

    public static void begin(Object original) {
        if (!(original instanceof EObject)) return;
        EObject root = (EObject) original;
        remember(root);
        root.eAllContents().forEachRemaining(SourceTrace::remember);
    }

    private static void remember(EObject object) {
        Issue.Location location = direct(object);
        if (location != null) origins.put(object, Collections.singletonList(location));
    }

    // Observe explicit trace calls and EMF copies without enabling KIELER's experimental tracing engine.
    public static void copied(EObject result, EObject original) {
        if (result == null || original == null || result == original) return;
        List<Issue.Location> source = origins.get(original);
        if (source == null) {
            Issue.Location location = direct(original);
            if (location != null) source = Collections.singletonList(location);
        }
        if (source == null) return;
        List<Issue.Location> merged = new ArrayList<>(origins.getOrDefault(result, Collections.emptyList()));
        for (Issue.Location location : source) add(merged, location);
        origins.put(result, merged);
    }

    public static List<Issue.Location> locations(Processor<?, ?> processor, EObject object) {
        List<Issue.Location> result = new ArrayList<>(origins.getOrDefault(object, Collections.emptyList()));
        if (object instanceof de.cau.cs.kieler.scg.Node) {
            for (de.cau.cs.kieler.kexpressions.keffects.Link link : ((de.cau.cs.kieler.scg.Node) object).getOutgoingLinks()) {
                if (link instanceof de.cau.cs.kieler.scg.GuardDependency) {
                    for (Issue.Location location : origins.getOrDefault(link.getTarget(), Collections.emptyList())) add(result, location);
                }
            }
        }
        if (result.isEmpty()) add(result, direct(object));
        return result;
    }

    public static Issue.Location direct(EObject object) {
        INode node = NodeModelUtils.getNode(object);
        if (node == null || object.eResource() == null || object.eResource().getURI() == null) return null;
        String uri = object.eResource().getURI().toString();
        if (!uri.startsWith("file:") || !uri.endsWith(".sctx")) return null;
        int start = node.getOffset() - node.getTotalOffset();
        String label = node.getText().substring(start, start + node.getLength()).trim().replaceAll("\\s+", " ");
        if (label.length() > 180) label = label.substring(0, 177) + "...";
        Issue.Location location = new Issue.Location(uri, node.getOffset(), node.getLength(), label);
        for (EObject element = object; element != null; element = element.eContainer()) {
            location.traceUris.add(org.eclipse.emf.ecore.util.EcoreUtil.getURI(element).toString());
        }
        return location;
    }

    public static void add(List<Issue.Location> list, Issue.Location location) {
        if (location != null && list.stream().noneMatch(l -> l.uri.equals(location.uri) && l.offset == location.offset && l.length == location.length)) list.add(location);
    }
}
