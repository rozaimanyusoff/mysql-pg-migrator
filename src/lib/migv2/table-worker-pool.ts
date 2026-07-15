export const MAX_CONCURRENT_TABLE_WORKERS = 5;

let activeWorkers = 0;
const waiters: Array<() => void> = [];

/** Process-wide table-worker budget shared by every active migration run. */
export async function acquireTableWorker(): Promise<() => void> {
  if (activeWorkers >= MAX_CONCURRENT_TABLE_WORKERS) {
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  activeWorkers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkers--;
    waiters.shift()?.();
  };
}

export async function runWithTableWorkerLimit<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const count = Math.max(1, Math.min(MAX_CONCURRENT_TABLE_WORKERS, Math.floor(concurrency), queue.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      const release = await acquireTableWorker();
      try { await worker(item); } finally { release(); }
    }
  }));
}

export function activeTableWorkersForTests(): number { return activeWorkers; }
