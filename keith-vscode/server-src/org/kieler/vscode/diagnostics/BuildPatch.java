package org.kieler.vscode.diagnostics;

import java.nio.file.*;
import java.util.jar.*;
import org.objectweb.asm.*;

/** Adds observation hooks while retaining the bundled compiler's implementation. */
public final class BuildPatch implements Opcodes {
    static final String BASE = "de/cau/cs/kieler/";
    static final String HOOK = "org/kieler/vscode/diagnostics/Hooks";
    static final String PROC = "L" + BASE + "kicool/compilation/Processor;";

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
        }
    }

    static void patch(JarFile jar, String out, String name, String method, String signature, int kind) throws Exception {
        String target = name.startsWith("org/") ? name : BASE + name;
        ClassReader reader = new ClassReader(jar.getInputStream(jar.getJarEntry(target + ".class")));
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        int[] matches = { 0 };
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
                        } else if (kind == 8) {
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
                            visitMethodInsn(INVOKESTATIC, "org/kieler/vscode/diagnostics/DiagramTrace", "populate", "(L" + target + ";)V", false);
                        }
                        super.visitInsn(opcode);
                    }
                };
            }
        }, 0);
        if (matches[0] != 1) throw new IllegalStateException("Unsupported server: " + target + "." + method);
        Path file = Paths.get(out, target + ".class");
        Files.createDirectories(file.getParent());
        Files.write(file, writer.toByteArray());
    }
}
