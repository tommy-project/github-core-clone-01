// The trial lifecycle: bind an ephemeral port, register it with the env,
// then poll the env's /done until the trial is over and exit 0. The server
// never exits before the env says it is done, and never holds a request open.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

async function postJson(url: string, value: unknown, timeoutMs = 5000): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<number> {
  if (!ENV_URL) {
    console.error('MAKEFUN_ENV_URL is not set');
    return 1;
  }
  const { server } = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind an ephemeral port'));
        return;
      }
      resolve(address.port);
    });
  });
  const register = await postJson(`${ENV_URL.replace(/\/+$/, '')}/register`, { port });
  if (register.status !== 200 && register.status !== 201 && register.status !== 409) {
    console.error(`register failed: HTTP ${register.status} ${register.text}`);
    server.close();
    return 1;
  }
  let delayMs = 100;
  for (;;) {
    const done = await getJson(`${ENV_URL.replace(/\/+$/, '')}/done`).catch(() => null);
    if (done !== null && typeof done === 'object' && (done as { done?: unknown }).done === true) break;
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 1000);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
