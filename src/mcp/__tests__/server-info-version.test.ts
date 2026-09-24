import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { _createMcpServerForTesting } from '../server.js';
import { readServerVersion } from '../version-info.js';

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

/**
 * issue #471: package.json の version が空でない string でなければ throw する。
 * SERVER_VERSION は module load 時にこの関数を呼ぶので、 不正な値では server が起動しない。
 */
describe('readServerVersion (issue #471)', () => {
  function withPackageJson(content: string, fn: (pkgPath: string) => void): void {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'server-version-'));
    try {
      const pkgPath = path.join(dir, 'package.json');
      writeFileSync(pkgPath, content);
      fn(pkgPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('version が空でない string ならそのまま返す', () => {
    withPackageJson(JSON.stringify({ version: '1.2.3' }), (pkgPath) => {
      expect(readServerVersion(pkgPath)).toBe('1.2.3');
    });
  });

  it.each([
    ['version key が無い', {}],
    ['version が number', { version: 1 }],
    ['version が null', { version: null }],
    ['version が空文字', { version: '' }],
    ['version が空白のみ', { version: '  ' }],
  ])('%s なら throw する', (_label, pkg) => {
    withPackageJson(JSON.stringify(pkg), (pkgPath) => {
      expect(() => readServerVersion(pkgPath)).toThrow(/version/);
    });
  });
});
