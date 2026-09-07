package org.kieler.vscode.diagnostics;

import org.eclipse.emf.common.util.URI;
import org.eclipse.emf.ecore.EObject;
import org.eclipse.emf.ecore.util.EcoreUtil;
import org.eclipse.xtext.nodemodel.INode;
import org.eclipse.xtext.nodemodel.util.NodeModelUtils;
import de.cau.cs.kieler.klighd.internal.util.KlighdInternalProperties;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramGenerator;

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
}
