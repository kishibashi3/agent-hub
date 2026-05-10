/**
 * CE operator tools — deployment 全体を運営する権限を持つ tool 群。
 *
 * 呼び出せるのは **default tenant の `@admin`** のみ。
 * これは CE deployment の operator 役 (TOFU で deploy 直後に claim する)。
 *
 * tenant 内 admin (delete_user / get_user_history、admin.ts 側) と
 * 区別すること: あちらは tenant 内の participant 管理、こちらは
 * tenant そのもののライフサイクル管理。
 *
 * operator は他 tenant の **存在 / 削除** を扱えるが、tenant 内のメッセージ
 * 内容は閲覧しない (privacy 保護)。
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TenantScope } from '../../db/tenant-scope.js';
import { DEFAULT_TENANT } from '../../db/tenants.js';

const CE_OPERATOR_HANDLE = '@admin';

/**
 * CE operator 権限チェック。default tenant の @admin だけ通す。
 */
function ensureCeOperator(
  userId: string,
  tenantDomain: string
): CallToolResult | null {
  if (tenantDomain === DEFAULT_TENANT && userId === CE_OPERATOR_HANDLE) {
    return null;
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            error: 'forbidden',
            message:
              'CE operator tools require @admin in default tenant (= deployment operator)',
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function errorResult(error: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }],
    isError: true,
  };
}

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

// ---- list_tenants -----------------------------------------------------------

export const listTenantsTool = {
  name: 'list_tenants',
  description:
    '[CE operator] deployment 全体の tenant 一覧を返す。各 tenant の domain / owner / 参加者数 / 作成日。default tenant の @admin だけ呼べる。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

interface TenantSummary {
  domain: string;
  owner: string | null;
  created_at: string;
  participant_count: number;
  message_count: number;
}

export async function handleListTenants(
  scope: TenantScope,
  _args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureCeOperator(userId, scope.tenantId);
  if (denied) return denied;

  const rows = scope.db
    .prepare(
      `SELECT
         t.domain,
         t.owner,
         t.created_at,
         (SELECT COUNT(*) FROM participants p
          WHERE p.tenant_id = t.domain AND p.deleted_at IS NULL) AS participant_count,
         (SELECT COUNT(*) FROM messages m
          WHERE m.tenant_id = t.domain) AS message_count
       FROM tenants t
       ORDER BY (t.domain = ?) DESC, t.created_at ASC`
    )
    .all(DEFAULT_TENANT) as TenantSummary[];

  return ok({ tenants: rows, count: rows.length });
}

// ---- get_tenant -------------------------------------------------------------

const getTenantInput = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]{1,64}$/i, 'invalid domain'),
});

export const getTenantTool = {
  name: 'get_tenant',
  description:
    '[CE operator] 特定 tenant の詳細を取得する。participants 一覧 (name / owner / mode / 作成日)、message 数を含む。default tenant の @admin だけ呼べる。プライバシー保護のためメッセージ本文は返さない。',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: '対象 tenant domain',
      },
    },
    required: ['domain'],
  },
};

interface TenantParticipantRow {
  name: string;
  display_name: string | null;
  owner: string | null;
  mode: string | null;
  created_at: string;
}

export async function handleGetTenant(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureCeOperator(userId, scope.tenantId);
  if (denied) return denied;

  let input: z.infer<typeof getTenantInput>;
  try {
    input = getTenantInput.parse(args);
  } catch (error) {
    return errorResult(
      'get_tenant failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const tenant = scope.db
    .prepare(
      'SELECT domain, owner, created_at FROM tenants WHERE domain = ?'
    )
    .get(input.domain) as
    | { domain: string; owner: string | null; created_at: string }
    | undefined;

  if (!tenant) {
    return errorResult(
      'get_tenant failed',
      `tenant '${input.domain}' は存在しません`
    );
  }

  const participants = scope.db
    .prepare(
      `SELECT name, display_name, owner, mode, created_at
       FROM participants
       WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`
    )
    .all(input.domain) as TenantParticipantRow[];

  const messageCount = (
    scope.db
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE tenant_id = ?')
      .get(input.domain) as { c: number }
  ).c;

  const teamCount = (
    scope.db
      .prepare('SELECT COUNT(*) AS c FROM teams WHERE tenant_id = ?')
      .get(input.domain) as { c: number }
  ).c;

  return ok({
    domain: tenant.domain,
    owner: tenant.owner,
    created_at: tenant.created_at,
    participants,
    message_count: messageCount,
    team_count: teamCount,
  });
}

// ---- delete_tenant ----------------------------------------------------------

const deleteTenantInput = z.object({
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]{1,64}$/i, 'invalid domain'),
  confirm: z
    .literal(true, {
      errorMap: () => ({
        message: 'confirm must be true (acknowledges all tenant data will be lost)',
      }),
    })
    .describe('hard delete を承諾する印 (true 必須)'),
});

export const deleteTenantTool = {
  name: 'delete_tenant',
  description:
    '[CE operator] tenant を強制削除する。tenant の participants / messages / teams / read_receipts を全部消す (hard delete)。default tenant は削除不可。confirm=true 必須。abuse 対策用。',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: '削除する tenant domain',
      },
      confirm: {
        type: 'boolean',
        description: '必ず true を渡すこと (操作の重さを宣言)',
      },
    },
    required: ['domain', 'confirm'],
  },
};

export async function handleDeleteTenant(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureCeOperator(userId, scope.tenantId);
  if (denied) return denied;

  let input: z.infer<typeof deleteTenantInput>;
  try {
    input = deleteTenantInput.parse(args);
  } catch (error) {
    return errorResult(
      'delete_tenant failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  if (input.domain === DEFAULT_TENANT) {
    return errorResult(
      'delete_tenant failed',
      'default tenant (= 雑談室) は削除できません'
    );
  }

  const exists = scope.db
    .prepare('SELECT 1 FROM tenants WHERE domain = ?')
    .get(input.domain);
  if (!exists) {
    return errorResult(
      'delete_tenant failed',
      `tenant '${input.domain}' は存在しません`
    );
  }

  // tenant 内データを cascade 削除 (FK 順序: 子 → 親)
  const transaction = scope.db.transaction((domain: string) => {
    scope.db.prepare('DELETE FROM read_receipts WHERE tenant_id = ?').run(domain);
    scope.db.prepare('DELETE FROM messages WHERE tenant_id = ?').run(domain);
    scope.db.prepare('DELETE FROM team_members WHERE tenant_id = ?').run(domain);
    scope.db.prepare('DELETE FROM teams WHERE tenant_id = ?').run(domain);
    scope.db.prepare('DELETE FROM participants WHERE tenant_id = ?').run(domain);
    scope.db.prepare('DELETE FROM tenants WHERE domain = ?').run(domain);
  });
  transaction(input.domain);

  return ok({ deleted: input.domain });
}
