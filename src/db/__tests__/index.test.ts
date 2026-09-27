import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase } from '../index.js';

describe('getDatabase', () => {
  const saved = process.env.AGENT_HUB_DB_PATH;
  let tmpDir: string | undefined;

  afterEach(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.AGENT_HUB_DB_PATH;
    else process.env.AGENT_HUB_DB_PATH = saved;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  // AGENT_HUB_DB_PATH は module の読み込み時ではなく getDatabase() の初回で読む。
  // entrypoint の dotenv.config() は import の評価より後に走るため (issue #470)
  it('import 後に設定した AGENT_HUB_DB_PATH で DB を開く', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-db-'));
    const dbPath = path.join(tmpDir, 'app.db');
    process.env.AGENT_HUB_DB_PATH = dbPath;

    expect(getDatabase().name).toBe(dbPath);
    closeDatabase();
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // 明示した path の親が無ければ作らずに失敗する (issue #533)
  it('明示した AGENT_HUB_DB_PATH の親ディレクトリが無ければ作らずに throw する', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-db-'));
    const dir = path.join(tmpDir, 'missing');
    process.env.AGENT_HUB_DB_PATH = path.join(dir, 'app.db');

    expect(() => getDatabase()).toThrow(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
