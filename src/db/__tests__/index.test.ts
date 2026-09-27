import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDbMount, closeDatabase, getDatabase } from '../index.js';

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

// /app/data が mount point でなければ WARN、AGENT_HUB_REQUIRE_DB_MOUNT なら throw (issue #537)
describe('checkDbMount', () => {
  const saved = process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
  const rootOnly = '1030 1011 0:77 / / rw,relatime master:1 - overlay overlay rw\n';
  const withData =
    rootOnly + '1031 1030 8:32 /home/admin/agent-hub/data /app/data rw,noatime - ext4 /dev/sdc rw\n';

  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
    else process.env.AGENT_HUB_REQUIRE_DB_MOUNT = saved;
  });

  it('/app/data が mount されていれば何も出さない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
    checkDbMount('/app/data', () => withData);
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT = '1';
    checkDbMount('/app/data', () => withData);
    expect(warn).not.toHaveBeenCalled();
  });

  it('/app/data が mount されていなければ WARN を出して続行する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
    checkDbMount('/app/data', () => rootOnly);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('will be lost when the container is recreated');
  });

  it('/app/data の下の dir が mount されていても /app/data の mount とはみなさない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
    checkDbMount('/app/data', () => rootOnly + '1031 1030 8:32 /x /app/data/sub rw - ext4 /dev/sdc rw\n');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('AGENT_HUB_REQUIRE_DB_MOUNT が設定されていて mount されていなければ throw する', () => {
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT = '1';
    expect(() => checkDbMount('/app/data', () => rootOnly)).toThrow('AGENT_HUB_REQUIRE_DB_MOUNT');
  });

  it('AGENT_HUB_REQUIRE_DB_MOUNT が空文字なら未設定と同じ (WARN のみ)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT = '';
    checkDbMount('/app/data', () => rootOnly);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('mountinfo が読めないとき、未設定なら何もせず、AGENT_HUB_REQUIRE_DB_MOUNT なら判定できない旨で throw する', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unreadable = () => {
      throw new Error('ENOENT');
    };
    delete process.env.AGENT_HUB_REQUIRE_DB_MOUNT;
    checkDbMount('/app/data', unreadable);
    expect(warn).not.toHaveBeenCalled();
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT = '1';
    expect(() => checkDbMount('/app/data', unreadable)).toThrow('/proc/self/mountinfo cannot be read');
  });

  it('DB の親 dir が /app/data 以外なら判定しない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.fn(() => rootOnly);
    process.env.AGENT_HUB_REQUIRE_DB_MOUNT = '1';
    checkDbMount('/home/me/agent-hub/data', read);
    checkDbMount('/app/data2', read);
    expect(read).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
