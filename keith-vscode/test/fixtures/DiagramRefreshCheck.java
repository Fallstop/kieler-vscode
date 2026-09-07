import de.cau.cs.kieler.klighd.lsp.KGraphDiagramUpdater;

class DiagramRefreshCheck {
    public static void main(String[] args) {
        // A refresh queued before closing its diagram no longer has a ViewContext.
        if (new KGraphDiagramUpdater().createModel(null, "file:///closed.sctx", null) != null) {
            throw new AssertionError("A closed diagram must not generate a replacement model");
        }
    }
}
