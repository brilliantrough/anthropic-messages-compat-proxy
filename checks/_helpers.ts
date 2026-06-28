import { createServer } from 'node:http';
import { once } from 'node:events';

export async function getAvailablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error('Failed to resolve available port');
  }
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}
