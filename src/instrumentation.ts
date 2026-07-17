export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startSchedulerWorker } = await import('./lib/migv2/scheduler-worker');
  startSchedulerWorker();
}
