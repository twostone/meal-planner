import { logger } from "./log.ts";

const log = logger("shutdown");

// What `serve()` returns (http or http2 server): all that is needed to stop it.
export type Closable = { close(callback?: (err?: Error) => void): unknown; closeAllConnections?: () => void };

export type ShutdownOptions = {
  /** HTTP servers returned by `serve()`; closed first so no new request arrives while the rest shuts down. */
  servers: Closable[];
  /** Everything else: stop timers, close the database. Runs after the servers are closed. */
  cleanup?: () => void | Promise<void>;
  /** Hard limit; the Supervisor sends SIGKILL after 10 s, which would leave the app in the "error" state. */
  timeoutMs?: number;
  exit?: (code: number) => void;
};

// PID 1 in a container gets no default signal handling: without a handler SIGTERM is ignored, `docker stop` waits for
// its timeout and then SIGKILLs the process (exit 137), which the Supervisor reports as "error" instead of "stopped".
// Returns the shutdown function so tests can call it directly.
export function gracefulShutdown(o: ShutdownOptions): (signal: string) => Promise<void> {
  const exit = o.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | null = null;
  return (signal) => {
    running ??= (async () => {
      log.info("signal", { signal });
      const force = setTimeout(() => {
        log.error("timeout", { ms: o.timeoutMs ?? 8000 });
        exit(1);
      }, o.timeoutMs ?? 8000);
      force.unref();
      try {
        await Promise.all(
          o.servers.map(
            (s) =>
              new Promise<void>((resolve) => {
                s.close(() => resolve());
                s.closeAllConnections?.(); // keep-alive connections would otherwise hold close() open
              }),
          ),
        );
        await o.cleanup?.();
        log.info("done");
        clearTimeout(force);
        exit(0);
      } catch (err) {
        log.error("failed", { error: err instanceof Error ? err.message : String(err) });
        clearTimeout(force);
        exit(1);
      }
    })();
    return running;
  };
}

export function installShutdownHandlers(o: ShutdownOptions): void {
  const shutdown = gracefulShutdown(o);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void shutdown(signal));
}
