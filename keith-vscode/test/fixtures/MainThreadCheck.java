import java.lang.reflect.Field;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import de.cau.cs.kieler.klighd.lsp.launch.AbstractLanguageServer;

class MainThreadCheck {
    @SuppressWarnings("unchecked")
    public static void main(String[] args) throws Exception {
        // The server's main-thread queue is private; drain it the way configureAndRun's loop does.
        Field field = AbstractLanguageServer.class.getDeclaredField("mainThreadQueue");
        field.setAccessible(true);
        BlockingQueue<Consumer<Void>> queue = (BlockingQueue<Consumer<Void>>) field.get(null);
        boolean[] inner = new boolean[1];
        Thread main = new Thread(() -> {
            try {
                while (!Thread.currentThread().isInterrupted()) {
                    synchronized (queue) {
                        while (queue.isEmpty()) queue.wait();
                        Consumer<Void> task = queue.peek();
                        task.accept(null);
                        queue.poll();
                        queue.notifyAll();
                    }
                }
            } catch (InterruptedException ignored) {
                // stopped
            }
        });
        main.start();
        Thread caller = new Thread(() -> AbstractLanguageServer.addToMainThreadQueue(ignored -> {
            // A task on the main thread that asks for more main-thread work, as a show-snapshot
            // whose layout future has already completed does. This waited for itself forever.
            AbstractLanguageServer.addToMainThreadQueue(nested -> inner[0] = true);
        }));
        caller.start();
        caller.join(TimeUnit.SECONDS.toMillis(10));
        main.interrupt();
        if (caller.isAlive() || !inner[0]) {
            throw new AssertionError("Work queued from the main thread must run instead of waiting for itself");
        }
    }
}
