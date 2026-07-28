import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

describe('MCP Hono runtime compatibility', () => {
  it('imports MCP and serves a bounded Hono POST request', async () => {
    const [{ McpServer }, { serve }, { Hono }] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@hono/node-server'),
      import('hono'),
    ]);

    expect(typeof McpServer).toBe('function');

    const app = new Hono();
    app.post('/health', async (context) => {
      const body = await context.req.json<{ probe: string }>();
      return context.json({ ok: body.probe === 'mcp-hono' });
    });

    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      if (!server.listening) {
        await once(server, 'listening', { signal: AbortSignal.timeout(2_000) });
      }
      const address = server.address() as AddressInfo | null;
      if (!address) {
        throw new Error('Hono test server did not expose a listening address');
      }

      const response = await new Promise<{ body: string; statusCode: number | undefined }>(
        (resolve, reject) => {
          const clientRequest = request({
            headers: { 'content-type': 'application/json' },
            host: '127.0.0.1',
            method: 'POST',
            path: '/health',
            port: address.port,
            signal: AbortSignal.timeout(2_000),
          }, (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.once('error', reject);
            incoming.once('end', () => {
              resolve({
                body: Buffer.concat(chunks).toString('utf-8'),
                statusCode: incoming.statusCode,
              });
            });
          });
          clientRequest.once('error', reject);
          clientRequest.end(JSON.stringify({ probe: 'mcp-hono' }));
        },
      );

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ok: true });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 5_000);
});
