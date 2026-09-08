package org.kieler.vscode.diagnostics;

import org.eclipse.elk.alg.layered.options.LayeredOptions;
import org.eclipse.elk.core.options.Direction;
import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.util.EcoreUtil;
import org.eclipse.xtext.nodemodel.INode;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;
import de.cau.cs.kieler.klighd.internal.util.KlighdInternalProperties;
import de.cau.cs.kieler.klighd.kgraph.KNode;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramGenerator;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramServer;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramState;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramUpdater;
import de.cau.cs.kieler.klighd.lsp.model.SKNode;
import de.cau.cs.kieler.klighd.ViewContext;
import org.eclipse.sprotty.SGraph;
import org.eclipse.xtext.util.CancelIndicator;

/** Publish KLighD's existing source associations so the client can highlight a conflict. */
public final class DiagramTrace {
    public static void populate(KGraphDiagramGenerator generator) {
        generator.getKGraphToSModelElementMap().forEach((graph, diagram) -> {
            Object source = graph.getProperties().get(KlighdInternalProperties.MODEL_ELEMENT);
            if (!(source instanceof EObject)) return;
            EObject object = (EObject) source;
            INode node = NodeModelUtils.getNode(object);
            if (node == null || object.eResource() == null) return;
            URI uri = EcoreUtil.getURI(object);
            if (!uri.isFile() || !"sctx".equals(uri.fileExtension())) return;
            var start = NodeModelUtils.getLineAndColumn(node, node.getOffset());
            var end = NodeModelUtils.getLineAndColumn(node, node.getEndOffset());
            String range = (start.getLine() - 1) + ":" + (start.getColumn() - 1) + "-" + (end.getLine() - 1) + ":" + (end.getColumn() - 1);
            diagram.setTrace(uri.trimFragment().appendQuery(range).appendFragment(uri.fragment()).toString());
        });
    }

    /** A superseded request's layout step finds its diagram context or element map already replaced. */
    public static boolean stale(KGraphDiagramState state, String uri) {
        synchronized (state) {
            return state.getKGraphContext(uri) == null || state.getKGraphToSModelElementMap(uri) == null;
        }
    }

    /** The bundled generator read the parent twice; a concurrent synthesis could detach the node in between. */
    public static void setDirection(SKNode diagram, KNode node) {
        KNode parent = node.getParent();
        diagram.setDirection((Direction) (parent != null ? parent : node).getProperty(LayeredOptions.DIRECTION));
    }

    /**
     * A synthesis rebuilds the view model on KLighD's main thread while another request may traverse it.
     * The bundled server serialized both with the diagram-state lock, which the queued layout step also
     * takes on the main thread, so waiting for the main thread while holding it deadlocked. This lock is
     * held for the whole of prepareModel and createModel, is always taken before the diagram-state lock,
     * and is never taken on the main thread.
     */
    private static final Object MODEL_LOCK = new Object();
    private static final ThreadLocal<Boolean> INSIDE = ThreadLocal.withInitial(() -> false);

    public static boolean inside() { return INSIDE.get(); }

    public static void prepareModel(KGraphDiagramUpdater updater, KGraphDiagramServer server, Object model, String uri) {
        synchronized (MODEL_LOCK) {
            INSIDE.set(true);
            try { updater.prepareModel(server, model, uri); } finally { INSIDE.set(false); }
        }
    }

    public static SGraph createModel(KGraphDiagramUpdater updater, ViewContext context, String uri, CancelIndicator cancel) {
        synchronized (MODEL_LOCK) {
            INSIDE.set(true);
            try { return updater.createModel(context, uri, cancel); } finally { INSIDE.set(false); }
        }
    }
}
