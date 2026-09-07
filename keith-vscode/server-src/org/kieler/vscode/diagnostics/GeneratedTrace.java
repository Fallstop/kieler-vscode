package org.kieler.vscode.diagnostics;

import java.util.*;
import org.eclipse.emf.ecore.EObject;
import de.cau.cs.kieler.kicool.compilation.CompilationContext;
import de.cau.cs.kieler.kicool.compilation.codegen.CodeGeneratorModule;

/** Records emitted C fragments together with their actual model origins. */
public final class GeneratedTrace {
    private static final Map<CompilationContext, Map<String, List<Issue.Location>>> fragments = Collections.synchronizedMap(new WeakHashMap<>());
    private static final ThreadLocal<Deque<Integer>> starts = ThreadLocal.withInitial(ArrayDeque::new);

    public static void begin(CompilationContext context) {
        starts.get().clear();
        fragments.remove(context);
    }

    public static void start(CodeGeneratorModule<?, ?> module) {
        starts.get().push(module.getCode().length());
    }

    public static void end(CodeGeneratorModule<?, ?> module, EObject object) {
        if (starts.get().isEmpty()) return;
        int start = starts.get().pop();
        if (start > module.getCode().length()) return;
        List<Issue.Location> locations = SourceTrace.locations(module.getProcessorInstance(), object);
        if (locations.isEmpty()) return;
        Map<String, List<Issue.Location>> mapping = fragments.computeIfAbsent(module.getProcessorInstance().getCompilationContext(), key -> new HashMap<>());
        for (String line : module.getCode().substring(start).split("\\r?\\n")) {
            String code = line.trim();
            if (code.isEmpty() || code.equals("}") || code.equals("{")) continue;
            List<Issue.Location> origins = mapping.computeIfAbsent(code, key -> new ArrayList<>());
            for (Issue.Location location : locations) SourceTrace.add(origins, location);
        }
    }

    public static List<Issue.Location> get(CompilationContext context, String line) {
        if (line == null) return Collections.emptyList();
        return fragments.getOrDefault(context, Collections.emptyMap()).getOrDefault(line.trim(), Collections.emptyList());
    }
}
