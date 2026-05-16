/**
 * Edition resolution — agent-hub の deployment edition を環境変数から決定する。
 *
 * agent-hub#10 (3-edition strategy) / agent-hub#18 (Private Edition) を実装。
 *
 * Edition 概観:
 *   - **Community Edition (CE)**: PAT 必須、multi-tenant、インターネット公開可
 *   - **Private Edition (PE)**: 認証なし (trust mode 固定)、default tenant のみ、完全 LAN 内専用
 *
 * Single source of truth として `resolveEdition(env)` を呼び、各レイヤ (auth /
 * tenant gate / tool list) はその結果の boolean フラグを参照する。env を直接
 * 読まない方針:
 *   - 「PE では @admin が無い」「PE では named tenant が無い」等の振る舞いを 1 箇所で導出
 *   - test で env を mock しやすい (関数引数で env を受ける)
 *
 * Backward compat: `AGENT_HUB_EDITION` 未指定 → `community` をデフォルト採用
 * (= secure by default、AUTH_MODE=trust の暗黙運用を抑止)。LAN dev で trust
 * mode を使いたかった既存利用者は `AGENT_HUB_EDITION=private` を明示する。
 */

export type Edition = 'community' | 'private';
export type AuthMode = 'trust' | 'pat';

/**
 * 解決後の edition 設定。各レイヤが参照する。
 *
 * - `edition`: log / health 表示用の正規化された edition 名
 * - `authMode`: 適用すべき auth mode (edition から一意に決まる)
 * - `allowsNamedTenant`: named tenant (X-Tenant-Id != 'default') を許容するか
 * - `enforcesDefaultTenantRestriction`: default tenant への外部 access を operator に
 *   限定する (= `AGENT_HUB_DISABLE_DEFAULT_TENANT` を honor する) か
 * - `enforcesDeploymentInitGate`: default tenant @admin 未 claim 時に named tenant
 *   への接続を 503 で塞ぐ deployment init gate を発動するか
 * - `exposesCeAdminTools`: list_tenants / get_tenant / delete_tenant 等の
 *   CE-operator tools を ListTools で露出するか
 */
export interface EditionConfig {
  edition: Edition;
  authMode: AuthMode;
  allowsNamedTenant: boolean;
  enforcesDefaultTenantRestriction: boolean;
  enforcesDeploymentInitGate: boolean;
  exposesCeAdminTools: boolean;
}

/**
 * Edition 解決で起き得る設定 conflict / unknown value のエラー。
 * `MCPServer.start` で catch して startup を fail-fast させる。
 */
export class EditionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditionConfigError';
  }
}

/**
 * env (= `process.env` 互換 dictionary) から edition 設定を解決する。
 *
 * 解決規則:
 *   1. `AGENT_HUB_EDITION` を読む。未指定 → `community` をデフォルト採用
 *   2. value validation: 'community' | 'private' 以外 → `EditionConfigError`
 *   3. `AUTH_MODE` が明示されていれば edition との整合性 check:
 *      - community + AUTH_MODE=trust → conflict (CE は PAT 必須)
 *      - private + AUTH_MODE=pat → conflict (PE は trust 固定)
 *      未指定なら edition から auto-derive
 *   4. CE 固有 flag (`AGENT_HUB_DISABLE_DEFAULT_TENANT`) は PE では無視されることを
 *      呼び出し側に伝えるため `enforcesDefaultTenantRestriction` で抽象化
 */
export function resolveEdition(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): EditionConfig {
  const editionRaw = env.AGENT_HUB_EDITION?.trim().toLowerCase() ?? 'community';
  if (editionRaw !== 'community' && editionRaw !== 'private') {
    throw new EditionConfigError(
      `AGENT_HUB_EDITION='${editionRaw}' は未知の値です。'community' か 'private' を指定してください。`
    );
  }
  const edition: Edition = editionRaw;

  const authModeRawRaw = env.AUTH_MODE?.trim().toLowerCase();
  const authModeExplicit: AuthMode | null =
    authModeRawRaw === 'trust' || authModeRawRaw === 'pat' ? authModeRawRaw : null;
  if (authModeRawRaw && authModeExplicit === null) {
    throw new EditionConfigError(
      `AUTH_MODE='${authModeRawRaw}' は未知の値です。'trust' か 'pat' を指定してください。`
    );
  }

  let authMode: AuthMode;
  if (edition === 'community') {
    // CE は PAT 必須。AUTH_MODE=trust を明示されたら conflict として弾く。
    if (authModeExplicit === 'trust') {
      throw new EditionConfigError(
        "AGENT_HUB_EDITION=community では AUTH_MODE=trust は使用できません。" +
          " LAN 専用運用なら AGENT_HUB_EDITION=private を指定してください。"
      );
    }
    authMode = 'pat';
  } else {
    // PE は trust 固定。AUTH_MODE=pat を明示されたら conflict として弾く。
    if (authModeExplicit === 'pat') {
      throw new EditionConfigError(
        "AGENT_HUB_EDITION=private では AUTH_MODE=pat は使用できません。" +
          " インターネット公開・PAT 認証で運用するなら AGENT_HUB_EDITION=community を指定してください。"
      );
    }
    authMode = 'trust';
  }

  if (edition === 'community') {
    // CE は従来通り `AGENT_HUB_DISABLE_DEFAULT_TENANT` を honor する。
    // 既定 (= 未指定 or '1') で secure-by-default (= default tenant 制限あり)、
    // '0' で明示 opt-out (= 雑談室として開放)。
    const restriction = env.AGENT_HUB_DISABLE_DEFAULT_TENANT !== '0';
    return {
      edition,
      authMode,
      allowsNamedTenant: true,
      enforcesDefaultTenantRestriction: restriction,
      enforcesDeploymentInitGate: true,
      exposesCeAdminTools: true,
    };
  }

  // PE は default tenant のみ + @admin 概念なし + CE-admin tools 非露出。
  // `AGENT_HUB_DISABLE_DEFAULT_TENANT` は意味を持たない (= silently ignore)。
  return {
    edition,
    authMode,
    allowsNamedTenant: false,
    enforcesDefaultTenantRestriction: false,
    enforcesDeploymentInitGate: false,
    exposesCeAdminTools: false,
  };
}
