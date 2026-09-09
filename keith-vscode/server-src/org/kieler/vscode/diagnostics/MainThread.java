package org.kieler.vscode.diagnostics;

import java.util.concurrent.BlockingQueue;
import java.util.function.Consumer;

/**
 * Replaces AbstractLanguageServer.addToMainThreadQueue. The bundled version shares one
 * notify() between the main thread and every waiting caller and makes each caller wait until
 * the whole queue drains, which only works while a single caller waits at a time. Once diagram
 * requests overlap, a wake-up can land on the wrong thread and everyone waits forever. Each
 * caller now waits for its own task and every state change wakes all waiters.
 *
 * A task can also re-enter: when a queued show-snapshot task finds the layout future already
 * complete, the continuation runs on the main thread and asks for a layout, which queues work
 * for the main thread and waits for it, that is, for itself. Work requested from the main
 * thread therefore runs inline.
 */
public final class MainThread {
    private static final ThreadLocal<Boolean> ON_MAIN_THREAD = ThreadLocal.withInitial(() -> false);

    public static void enqueue(BlockingQueue<Consumer<Void>> queue, Consumer<Object> task) {
        if (ON_MAIN_THREAD.get()) {
            task.accept(null);
            return;
        }
        Throwable[] failure = new Throwable[1];
        boolean[] done = new boolean[1];
        synchronized (queue) {
            queue.add(ignored -> {
                ON_MAIN_THREAD.set(true);
                try {
                    task.accept(ignored);
                } catch (Throwable t) {
                    failure[0] = t;
                } finally {
                    ON_MAIN_THREAD.set(false);
                    synchronized (queue) {
                        done[0] = true;
                        queue.notifyAll();
                    }
                }
            });
            queue.notifyAll();
            while (!done[0]) {
                try {
                    queue.wait();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw MainThread.<RuntimeException>sneaky(e);
                }
            }
        }
        if (failure[0] != null) throw MainThread.<RuntimeException>sneaky(failure[0]);
    }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> T sneaky(Throwable t) throws T { throw (T) t; }
}
