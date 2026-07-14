export async function runSequentially<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  for (const item of items) {
    if (shouldStop()) break;
    await worker(item);
  }
}
