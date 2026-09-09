import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.kieler.vscode.diagnostics.MainThread;

class MainThreadCheck {
    public static void main(String[] args) throws Exception {
        BlockingQueue<Consumer<Void>> queue = new LinkedBlockingQueue<>();
        boolean[] inner = new boolean[1];
        // Drains the queue the way the language server's main loop does.
        Thread main = new Thread(() -> {
            try {
                while (!Thread.currentThread().isInterrupted()) queue.take().accept(null);
            } catch (InterruptedException ignored) {
                // stopped
            }
        });
        main.start();
        Thread caller = new Thread(() -> MainThread.enqueue(queue, ignored -> {
            // A task on the main thread that asks for more main-thread work, as a show-snapshot
            // whose layout future has already completed does. This waited for itself forever.
            MainThread.enqueue(queue, nested -> inner[0] = true);
        }));
        caller.start();
        caller.join(TimeUnit.SECONDS.toMillis(10));
        main.interrupt();
        if (caller.isAlive() || !inner[0]) {
            throw new AssertionError("Work queued from the main thread must run instead of waiting for itself");
        }
    }
}
