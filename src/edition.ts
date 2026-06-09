/**
 * Edition resolution — agent-hub の deployment edition を環境変数から決定する。
 *
 * agent-hub#10 (3-edition strategy) / agent-hub#18 (Private Edition) を実装。
 * issue #271: trust mode 廃止、pat mode のみサポート。
 *
 * Edition 概観:
 *   - **Community Edition (CE)**: PAT 必須、multi-tenant、インターネット公開可
 *   - **Private Edition (PE)**: PAT 必須、default tenant のみ、LAN 内専用
 *
 * Single source of truth として `resolveEdition(env)` を呼び、各レイヤ (auth /
 * tenant gate / tool list) はその結果の boolean フラグを参照する。env を直接
 * 読まない方針:
 *   - 「PE では @admin が無い」「PE では named tenant が無い」等の振る舞いを 1 箇所で導出
 *   - test で env を mock しやすい (関数引数で env を受ける)
 *
 * `AGENT_HUB_EDITION` は必須。未指定 or 空文字 → `EditionConfigError` で起動失敗 (issue #55 fix)。
 */

export type Edition = 'community' | 'private';
export type AuthMode = 'pat';

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
 *   1. `AGENT_HUB_EDITION` を読む。未指定 or 空文字 → `EditionConfigError` (= 起動失敗)
 *   2. value validation: 'community' | 'private' 以外 → `EditionConfigError`
 *   3. `AGENT_HUB_AUTH_MODE` 値 validation: 'pat' 以外 → `EditionConfigError`
 *      ('trust' は issue #271 で廃止。設定されていたら migration hint 付きエラー)
 *   4. CE 固有 flag (`AGENT_HUB_DISABLE_DEFAULT_TENANT`) は PE で設定されていたら
 *      WARN log を出力 (silent ignore 廃止、設定意図の自覚を促す)
 *
 * 副作用: PE+restriction path で `console.warn` を出力する。
 * 例外は `EditionConfigError` のみ (= 設定ミス path のみ throw)。
 */
export function resolveEdition(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): EditionConfig {
  const editionRaw = env.AGENT_HUB_EDITION?.trim().toLowerCase();
  if (!editionRaw) {
    // issue #55 fix (redline #1): env 未設定時の silent community fallback を廃止。
    // PE 環境で AGENT_HUB_EDITION 設定漏れが PAT 必須 CE として silent start するリスクを排除する。
    throw new EditionConfigError(
      "AGENT_HUB_EDITION が未設定です。'community' か 'private' を指定してください。"
    );
  }
  if (editionRaw !== 'community' && editionRaw !== 'private') {
    throw new EditionConfigError(
      `AGENT_HUB_EDITION='${editionRaw}' は未知の値です。'community' か 'private' を指定してください。`
    );
  }
  const edition: Edition = editionRaw;

  const authModeRaw = env.AGENT_HUB_AUTH_MODE?.trim().toLowerCase();
  if (authModeRaw === 'trust') {
    throw new EditionConfigError(
      "AGENT_HUB_AUTH_MODE='trust' は廃止されました (issue #271)。" +
        " AGENT_HUB_AUTH_MODE=pat を指定してください。"
    );
  }
  if (authModeRaw && authModeRaw !== 'pat') {
    throw new EditionConfigError(
      `AGENT_HUB_AUTH_MODE='${authModeRaw}' は未知の値です。'pat' を指定してください。`
    );
  }

  const authMode: AuthMode = 'pat';

  if (edition === 'community') {
    // CE は `AGENT_HUB_DISABLE_DEFAULT_TENANT` を honor する。
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
  // `AGENT_HUB_DISABLE_DEFAULT_TENANT` は意味を持たないが、設定意図の自覚を促すため WARN log を出す。
  if (env.AGENT_HUB_DISABLE_DEFAULT_TENANT !== undefined) {
    console.warn(
      '[PE] AGENT_HUB_DISABLE_DEFAULT_TENANT is set but has no effect in private edition'
    );
  }
  return {
    edition,
    authMode,
    allowsNamedTenant: false,
    enforcesDefaultTenantRestriction: false,
    enforcesDeploymentInitGate: false,
    exposesCeAdminTools: false,
  };
}
