import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { sendMessageTool, handleSendMessage } from '../send_message.js';
import { applyMigrations } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';

describe('send_message tool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  describe('tool definition', () => {
    it('should have correct name and structure', () => {
      expect(sendMessageTool.name).toBe('send_message');
      expect(sendMessageTool.inputSchema.type).toBe('object');
      expect(sendMessageTool.inputSchema.required).toEqual(['to', 'message']);
    });

    it('should have to and message in properties', () => {
      const props = sendMessageTool.inputSchema.properties;
      expect(props.to).toBeDefined();
      expect(props.message).toBeDefined();
      expect(props.to.type).toBe('string');
      expect(props.message.type).toBe('string');
    });
  });

  describe('handleSendMessage - 正常系', () => {
    beforeEach(() => {
      // 参加者を登録
      db.prepare(
        'INSERT INTO participants (tenant_id, name, display_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@alice', 'Alice', new Date().toISOString());
      db.prepare(
        'INSERT INTO participants (tenant_id, name, display_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@bob', 'Bob', new Date().toISOString());
      db.prepare(
        'INSERT INTO participants (tenant_id, name, display_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@charlie', 'Charlie', new Date().toISOString());

      // チームを作成
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO teams (tenant_id, name, owner, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@team-a', '@alice', now);
      db.prepare(
        'INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
      ).run('default', '@team-a', '@alice');
      db.prepare(
        'INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
      ).run('default', '@team-a', '@bob');
    });

    it('should send DM to another participant', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'Hello Bob!' },
        '@alice'
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const data = JSON.parse(result.content[0].text);
      expect(data.from).toBe('@alice');
      expect(data.to).toBe('@bob');
      expect(data.message).toBe('Hello Bob!');
      expect(data.id).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    it('should accept sender without @ prefix', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'Test' },
        'alice'
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.from).toBe('@alice');
    });

    it('should send message to team', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@team-a', message: 'Team message!' },
        '@alice'
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.from).toBe('@alice');
      expect(data.to).toBe('@team-a');
      expect(data.message).toBe('Team message!');
    });

    it('should allow team member to send to team', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@team-a', message: 'From Bob' },
        '@bob'
      );

      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.from).toBe('@bob');
      expect(data.to).toBe('@team-a');
    });
  });

  describe('handleSendMessage - 異常系', () => {
    beforeEach(() => {
      // 参加者を登録
      db.prepare(
        'INSERT INTO participants (tenant_id, name, display_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@alice', 'Alice', new Date().toISOString());
      db.prepare(
        'INSERT INTO participants (tenant_id, name, display_name, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@bob', 'Bob', new Date().toISOString());

      // チームを作成（alice のみメンバー）
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO teams (tenant_id, name, owner, created_at) VALUES (?, ?, ?, ?)'
      ).run('default', '@team-a', '@alice', now);
      db.prepare(
        'INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
      ).run('default', '@team-a', '@alice');
    });

    it('should reject if sender is not registered', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: 'Test' },
        '@unknown'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
      expect(data.message).toContain('登録されていません');
    });

    it('should reject if recipient does not exist', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@nonexistent', message: 'Test' },
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.message).toContain('存在しません');
    });

    it('should reject if non-member tries to send to team', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@team-a', message: 'Test' },
        '@bob'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.message).toContain('メンバーのみ');
    });

    it('should reject if to is empty', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '', message: 'Test' },
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
    });

    it('should reject if message is empty', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob', message: '' },
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
    });

    it('should reject if to is missing', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { message: 'Test' },
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
    });

    it('should reject if message is missing', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: '@bob' },
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
    });

    it('should reject if args is not an object', async () => {
      const result = await handleSendMessage(
        scopeToTenant(db, 'default'),
        'invalid',
        '@alice'
      );

      expect(result.isError).toBe(true);
      const data = JSON.parse(result.content[0].text);
      expect(data.error).toBe('send_message failed');
    });
  });
});
