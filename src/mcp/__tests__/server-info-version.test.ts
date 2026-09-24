import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _createMcpServerForTesting } from '../server.js';

/**
 * issue #322 (a): MCP initialize の serverInfo.version が package.json の version と一致すること。
 * server.ts に literal を書かず、 package.json を唯一の出どころにする。
 */
describe('serverInfo.version (issue #322)', () => {
  it('initialize の応答の serverInfo.version が package.json の version と一致する', async () => {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const pkgVersion = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;

    const server = _createMcpServerForTesting();
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toEqual({ name: 'agent-hub', version: pkgVersion });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
