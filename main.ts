// main.ts — the entrypoint. Binds an ephemeral port (never 8080), registers it
// with the trial environment, then long-polls /done until the suite is over and
// exits 0. Without MAKEFUN_ENV_URL (local development) it just serves forever and
// prints the port. The forge keeps all state in memory; nothing is written to
// disk, so a read-only /bot and a mounted /output are both safe.

import { createForgeServer } from './src/server.ts';
import { Store } from './src/store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const HOST = '127.0.0.1';

function log(message: string): void {
  process.stdout.write(`[forge] ${message}\n`);
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/u, '')}/register`;
  const body = JSON.stringify({ port });
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        log(`registered port ${port} with the environment`);
        return;
      }
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    log(`register attempt ${attempt} failed (${lastError instanceof Error ? lastError.message : String(lastError)}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`could not register with the environment: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/u, '')}/done`;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        if (parsed !== null && typeof parsed === 'object' && (parsed as { done?: unknown }).done === true) {
          log('the environment reports done');
          return;
        }
      }
    } catch {
      // A long-poll timeout or a dropped connection is not fatal: poll again.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createForgeServer({ store, token: TOKEN });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('could not read the bound address');
  const port = address.port;
  log(`listening on http://${HOST}:${port}${TOKEN === '' ? ' (no token configured: auth open)' : ''}`);
  if (ENV_URL === '') {
    log('MAKEFUN_ENV_URL is not set; serving without registering (local development)');
    return;
  }
  await register(port);
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  log('shutting down');
}

main().catch((err: unknown) => {
  process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
