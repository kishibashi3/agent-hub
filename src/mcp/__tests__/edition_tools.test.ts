import { describe, it, expect } from 'vitest';
import { getAvailableTools } from '../server.js';
import { resolveEdition } from '../../edition.js';

/**
 * ListTools で露出される tool 一覧が edition によって変わることを単体検証する。
 *
 * - CE: 全 tool (base 9 + admin 2 + CE-operator 3 = 14) が露出
 * - PE: CE-operator 3 (list_tenants / get_tenant / delete_tenant) が除外され 11 件
 *
 * CallTool 側の defense-in-depth (= PE で CE-operator tool 名を直接 call して error)
 * は createMcpServer 内 closure のため本 file では cover しない。E2E は別途。
 */
describe('getAvailableTools (edition × tool list)', () => {
  function names(tools: Array<unknown>): string[] {
    return tools.map((t) => (t as { name: string }).name);
  }

  it('CE: 全 tool が露出される (base + admin + CE-operator)', () => {
    const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
    const tools = getAvailableTools(cfg);
    const ns = names(tools);
    // base
    expect(ns).toContain('register');
    expect(ns).toContain('send_message');
    expect(ns).toContain('get_messages');
    expect(ns).toContain('get_participants');
    expect(ns).toContain('create_team');
    // admin
    expect(ns).toContain('delete_user');
    expect(ns).toContain('get_user_history');
    // CE-operator
    expect(ns).toContain('list_tenants');
    expect(ns).toContain('get_tenant');
    expect(ns).toContain('delete_tenant');
  });

  it('PE: CE-operator tools (list_tenants / get_tenant / delete_tenant) は除外される', () => {
    const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
    const tools = getAvailableTools(cfg);
    const ns = names(tools);
    expect(ns).not.toContain('list_tenants');
    expect(ns).not.toContain('get_tenant');
    expect(ns).not.toContain('delete_tenant');
  });

  it('PE: base + admin tools は引き続き露出される', () => {
    const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
    const tools = getAvailableTools(cfg);
    const ns = names(tools);
    // base
    expect(ns).toContain('register');
    expect(ns).toContain('send_message');
    expect(ns).toContain('get_messages');
    expect(ns).toContain('get_participants');
    expect(ns).toContain('create_team');
    expect(ns).toContain('update_team');
    expect(ns).toContain('delete_team');
    expect(ns).toContain('get_history');
    expect(ns).toContain('mark_as_read');
    // admin tools は PE でも保持 (= 1 default tenant 内での admin 操作は意味がある)
    expect(ns).toContain('delete_user');
    expect(ns).toContain('get_user_history');
  });

  it('CE と PE で件数の差 = 3 (= CE-operator tools の数)', () => {
    const ce = resolveEdition({ AGENT_HUB_EDITION: 'community' });
    const pe = resolveEdition({ AGENT_HUB_EDITION: 'private' });
    expect(getAvailableTools(ce).length - getAvailableTools(pe).length).toBe(3);
  });
});
