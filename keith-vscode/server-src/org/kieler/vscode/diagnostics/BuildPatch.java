package org.kieler.vscode.diagnostics;

import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;

/** Adds observation hooks while retaining the bundled compiler's implementation. */
public final class BuildPatch implements Opcodes {
    static final String BASE = "de/cau/cs/kieler/";
    static final String HOOK = "org/kieler/vscode/diagnostics/Hooks";
    static final String TRACE = "org/kieler/vscode/diagnostics/DiagramTrace";
    static final String PROC = "L" + BASE + "kicool/compilation/Processor;";
    /** Classes rewritten so far; a later kind patches the rewritten bytes, never a stale file. */
    static final java.util.Map<String, byte[]> rewritten = new java.util.HashMap<>();

    public static void main(String[] args) throws Exception {
        try (JarFile jar = new JarFile(args[0])) {
            patch(jar, args[1], "kicool/compilation/CompilationContext", "compile", "()L" + BASE + "kicool/environments/Environment;", 0);
            patch(jar, args[1], "scg/processors/SimpleGuardScheduler", "schedule", "(L" + BASE + "scg/SCGraph;)V", 1);
            patch(jar, args[1], "kicool/deploy/processor/AbstractSystemCompilerProcessor", "invoke", "(Ljava/util/List;Ljava/io/File;)Ljava/lang/Integer;", 2);
            patch(jar, args[1], "org/eclipse/emf/ecore/util/EcoreUtil$Copier", "copy", "(Lorg/eclipse/emf/ecore/EObject;)Lorg/eclipse/emf/ecore/EObject;", 3);
            patch(jar, args[1], "kicool/kitt/tracing/TransformationTracing", "trace", "(Lorg/eclipse/emf/ecore/EObject;Lorg/eclipse/emf/ecore/EObject;)Lorg/eclipse/emf/ecore/EObject;", 4);
            patch(jar, args[1], "scg/processors/codegen/c/CCodeGeneratorLogicModule", "serializeToCode", "(L" + BASE + "scg/Assignment;IL" + BASE + "scg/processors/codegen/c/CCodeGeneratorStructModule;L" + BASE + "scg/processors/codegen/c/CCodeSerializeHRExtensions;)V", 5);
            patch(jar, args[1], "simulation/processor/CSimulationTemplateGenerator", "generateTemplate", "()L" + BASE + "kicool/compilation/CodeContainer;", 6);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramGenerator", "postProcess", "()V", 7);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramUpdater", "createModel", "(L" + BASE + "klighd/ViewContext;Ljava/lang/String;Lorg/eclipse/xtext/util/CancelIndicator;)Lorg/eclipse/sprotty/SGraph;", 8);
            patch(jar, args[1], "scg/processors/analyzer/LoopAnalyzerV2", "process", "()V", 9);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramGenerator", "setProperties", "(L" + BASE + "klighd/lsp/model/SKNode;L" + BASE + "klighd/kgraph/KNode;)V", 10);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramUpdater", "prepareModel", "(L" + BASE + "klighd/lsp/KGraphDiagramServer;Ljava/lang/Object;Ljava/lang/String;)V", 11);
            patch(jar, args[1], "klighd/lsp/KGraphLanguageServerExtension", "showSnapshot", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/Object;Lorg/eclipse/xtext/util/CancelIndicator;Z)Ljava/lang/String;", 12);
            patch(jar, args[1], "klighd/lsp/KGraphLayoutEngine", "onlyLayoutOnKGraph", "(Ljava/lang/String;)V", 13);
            patch(jar, args[1], "klighd/lsp/utils/KGraphMappingUtil", "mapLayout", "(Ljava/util/Map;)V", 14);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramServer", "prepareUpdateModel", "(Lorg/eclipse/sprotty/SModelRoot;)V", 15);
            patch(jar, args[1], "klighd/lsp/KGraphDiagramUpdater", "lambda$updateDiagram$5", "(Ljava/lang/String;L" + BASE + "klighd/lsp/KGraphDiagramServer;Lorg/eclipse/emf/ecore/resource/Resource;Lorg/eclipse/xtext/util/CancelIndicator;)Ljava/lang/Void;", 12);
        }
    }

    static void patch(JarFile jar, String out, String name, String method, String signature, int kind) throws Exception {
        String target = name.startsWith("org/") ? name : BASE + name;
        byte[] input = rewritten.containsKey(target) ? rewritten.get(target) : jar.getInputStream(jar.getJarEntry(target + ".class")).readAllBytes();
        ClassReader reader = new ClassReader(input);
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        int[] matches = { 0 }, edits = { 0 };
        reader.accept(new ClassVisitor(ASM9, writer) {
            @Override public MethodVisitor visitMethod(int access, String n, String desc, String sig, String[] ex) {
                MethodVisitor original = super.visitMethod(access, n, desc, sig, ex);
                if (!n.equals(method) || !desc.equals(signature)) return original;
                matches[0]++;
                return new MethodVisitor(ASM9, original) {
                    @Override public void visitCode() {
                        super.visitCode();
                        if (kind == 0) {
                            visitVarInsn(ALOAD, 0);
                            visitMethodInsn(INVOKESTATIC, HOOK, "begin", "(L" + target + ";)V", false);
                        } else if (kind == 4) {
                            visitVarInsn(ALOAD, 0);
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/SourceTrace", "copied", "(Lorg/eclipse/emf/ecore/EObject;Lorg/eclipse/emf/ecore/EObject;)V", false);
                        } else if (kind == 5) {
                            visitVarInsn(ALOAD, 0);
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/GeneratedTrace", "start", "(L" + BASE + "kicool/compilation/codegen/CodeGeneratorModule;)V", false);
                        } else if (kind == 8 || kind == 11) {
                            // Serialize synthesis and traversal: outside the model lock, delegate to the locked
                            // helper, which calls back in with the lock held.
                            Label locked = new Label();
                            visitMethodInsn(INVOKESTATIC, TRACE, "inside", "()Z", false);
                            visitJumpInsn(IFNE, locked);
                            for (int slot = 0; slot < 4; slot++) visitVarInsn(ALOAD, slot);
                            visitMethodInsn(INVOKESTATIC, TRACE, method, "(L" + target + ";" + signature.substring(1), false);
                            visitInsn(kind == 8 ? ARETURN : RETURN);
                            visitLabel(locked);
                            visitFrame(F_SAME, 0, null, 0, null);
                            if (kind == 8) {
                                // A queued refresh can outlive its closed/replaced diagram context.
                                // The caller already treats a null model as a cancelled refresh.
                                Label present = new Label();
                                visitVarInsn(ALOAD, 1);
                                visitJumpInsn(IFNONNULL, present);
                                visitInsn(ACONST_NULL);
                                visitInsn(ARETURN);
                                visitLabel(present);
                                visitFrame(F_SAME, 0, null, 0, null);
                            }
                        } else if (kind == 13) {
                            // A later request replaced this diagram; laying out the old model would only fail.
                            Label current = new Label();
                            visitVarInsn(ALOAD, 0);
                            visitFieldInsn(GETFIELD, target, "diagramState", "L" + BASE + "klighd/lsp/KGraphDiagramState;");
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKESTATIC, TRACE, "stale", "(L" + BASE + "klighd/lsp/KGraphDiagramState;Ljava/lang/String;)Z", false);
                            visitJumpInsn(IFEQ, current);
                            visitInsn(RETURN);
                            visitLabel(current);
                            visitFrame(F_SAME, 0, null, 0, null);
                        } else if (kind == 15) {
                            // A newer request already replaced this diagram; its model must not reach the client.
                            Label current = new Label();
                            visitVarInsn(ALOAD, 1);
                            visitJumpInsn(IFNULL, current);
                            visitVarInsn(ALOAD, 0);
                            visitFieldInsn(GETFIELD, target, "diagramState", "L" + BASE + "klighd/lsp/KGraphDiagramState;");
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKEVIRTUAL, "org/eclipse/sprotty/SModelRoot", "getId", "()Ljava/lang/String;", false);
                            visitMethodInsn(INVOKESTATIC, TRACE, "stale", "(L" + BASE + "klighd/lsp/KGraphDiagramState;Ljava/lang/String;)Z", false);
                            visitJumpInsn(IFEQ, current);
                            visitInsn(RETURN);
                            visitLabel(current);
                            visitFrame(F_SAME, 0, null, 0, null);
                        } else if (kind == 14) {
                            // The element map of a replaced diagram is gone; there is nothing left to position.
                            Label present = new Label();
                            visitVarInsn(ALOAD, 0);
                            visitJumpInsn(IFNONNULL, present);
                            visitInsn(RETURN);
                            visitLabel(present);
                            visitFrame(F_SAME, 0, null, 0, null);
                        } else if (kind == 10) {
                            // Replace the body; the original remains as unreachable code behind a frame.
                            Label original = new Label();
                            visitVarInsn(ALOAD, 1);
                            visitVarInsn(ALOAD, 2);
                            visitMethodInsn(INVOKESTATIC, TRACE, "setDirection", signature, false);
                            visitInsn(RETURN);
                            visitLabel(original);
                            visitFrame(F_SAME, 0, null, 0, null);
                        }
                    }
                    @Override public void visitInsn(int opcode) {
                        if (kind == 1 && opcode == RETURN) {
                            visitVarInsn(ALOAD, 0);
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKESTATIC, HOOK, "scheduled", "(" + PROC + "L" + BASE + "scg/SCGraph;)V", false);
                        } else if (kind == 2 && opcode == ARETURN) {
                            visitInsn(DUP);
                            visitVarInsn(ALOAD, 0);
                            visitVarInsn(ALOAD, 1);
                            visitVarInsn(ALOAD, 2);
                            visitVarInsn(ALOAD, 0);
                            visitFieldInsn(GETFIELD, target, "logger", "L" + BASE + "kicool/deploy/Logger;");
                            visitMethodInsn(INVOKESTATIC, HOOK, "nativeResult", "(Ljava/lang/Integer;" + PROC + "Ljava/util/List;Ljava/io/File;L" + BASE + "kicool/deploy/Logger;)V", false);
                        } else if (kind == 3 && opcode == ARETURN) {
                            visitInsn(DUP);
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/SourceTrace", "copied", "(Lorg/eclipse/emf/ecore/EObject;Lorg/eclipse/emf/ecore/EObject;)V", false);
                        } else if (kind == 5 && opcode == RETURN) {
                            visitVarInsn(ALOAD, 0);
                            visitVarInsn(ALOAD, 1);
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/GeneratedTrace", "end", "(L" + BASE + "kicool/compilation/codegen/CodeGeneratorModule;Lorg/eclipse/emf/ecore/EObject;)V", false);
                        } else if (kind == 6 && opcode == ARETURN) {
                            visitInsn(DUP);
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/SimulationStrings", "retain", "(L" + BASE + "kicool/compilation/CodeContainer;)V", false);
                        } else if (kind == 7 && opcode == RETURN) {
                            visitVarInsn(ALOAD, 0);
                            visitMethodInsn(INVOKESTATIC, TRACE, "populate", "(L" + target + ";)V", false);
                        } else if (kind == 9 && opcode == RETURN) {
                            visitVarInsn(ALOAD, 0);
                            visitMethodInsn(INVOKESTATIC, HOOK, "loops", "(" + PROC + ")V", false);
                        } else if (kind == 12 && (opcode == MONITORENTER || opcode == MONITOREXIT)) {
                            // The first block guards a map read or write. The second waited for the main thread while
                            // holding the diagram-state lock, which queued main-thread steps also need: a deadlock.
                            edits[0]++;
                            if (edits[0] > 3) { super.visitInsn(POP); return; }
                        }
                        super.visitInsn(opcode);
                    }
                };
            }
        }, 0);
        if (matches[0] != 1) throw new IllegalStateException("Unsupported server: " + target + "." + method);
        if (kind == 12 && edits[0] != 6) throw new IllegalStateException("Unsupported server: " + target + "." + method + " has " + edits[0] + " monitor instructions");
        Path file = Paths.get(out, target + ".class");
        Files.createDirectories(file.getParent());
        rewritten.put(target, writer.toByteArray());
        Files.write(file, rewritten.get(target));
    }
}
