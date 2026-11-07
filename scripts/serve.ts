import { startWebServer, drainWebServer } from '../src/web/server.ts';

const server = await startWebServer({ host: '0.0.0.0', port: 8787 });
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const configured = Number(process.env.BOLE_SHUTDOWN_TIMEOUT_MS ?? 60000);
  const timeout = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 120000) : 60000;
  try { await drainWebServer(server, timeout); }
  catch (error) { process.stderr.write(`Shutdown: ${String(error)}\n`); process.exitCode = 1; }
  finally { process.exit(process.exitCode ?? 0); }
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
