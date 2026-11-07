try {
  const response = await fetch('http://127.0.0.1:8787/readyz', { signal: AbortSignal.timeout(5000) });
  process.exitCode = response.ok ? 0 : 1;
} catch { process.exitCode = 1; }
