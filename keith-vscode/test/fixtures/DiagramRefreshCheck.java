import de.cau.cs.kieler.klighd.kgraph.KGraphFactory;
import de.cau.cs.kieler.klighd.kgraph.KNode;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramGenerator;
import de.cau.cs.kieler.klighd.lsp.KGraphDiagramUpdater;
import de.cau.cs.kieler.klighd.lsp.model.SKNode;
import org.eclipse.elk.alg.layered.options.LayeredOptions;
import org.eclipse.elk.core.options.Direction;

class DiagramRefreshCheck {
    public static void main(String[] args) {
        // A refresh queued before closing its diagram no longer has a ViewContext.
        if (new KGraphDiagramUpdater().createModel(null, "file:///closed.sctx", null) != null) {
            throw new AssertionError("A closed diagram must not generate a replacement model");
        }
        // A node detached by a concurrent synthesis has no parent while it is still being traversed.
        KNode node = KGraphFactory.eINSTANCE.createKNode();
        node.setProperty(LayeredOptions.DIRECTION, Direction.DOWN);
        SKNode diagram = new SKNode();
        new KGraphDiagramGenerator().setProperties(diagram, node);
        if (diagram.getDirection() != Direction.DOWN) {
            throw new AssertionError("A parentless node must use its own layout direction");
        }
    }
}
