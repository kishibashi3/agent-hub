/**
 * Edition resolution — agent-hub の deployment edition を環境変数から決定する。
 *
 * agent-hub#10 (3-edition strategy) / agent-hub#18 (Private Edition) を実装。
 * v2 設計 (PR #23 にて 1d=(B), Minor 1-4, Sug 1+3 確定) を反映:
 *   - CE+`AGENT_HUB_AUTH_MODE=trust` は v1 では WARN-only で許容、v2 で hard reject に格上げ
 *   - 延命 opt-in env `AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1` で v2 まで猶予
 *   - PE+`AGENT_HUB_DISABLE_DEFAULT_TENANT` は startup で WARN log (silent ignore 廃止)
 *   - error message は両方向 migration hint で対称化
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
 * `AGENT_HUB_EDITION` は必須。未指定 or 空文字 → `EditionConfigError` で起動失敗 (issue #55 fix)。
 * LAN dev で trust mode を使いたい場合は `AGENT_HUB_EDITION=private` を明示する。
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
 * 解決規則 (v2 設計反映):
 *   1. `AGENT_HUB_EDITION` を読む。未指定 or 空文字 → `EditionConfigError` (= 起動失敗)
 *   2. value validation: 'community' | 'private' 以外 → `EditionConfigError`
 *   3. `AGENT_HUB_AUTH_MODE` 値 validation: 'trust' | 'pat' 以外 → `EditionConfigError`
 *   4. edition + AGENT_HUB_AUTH_MODE 整合性 check:
 *      - **CE + `AGENT_HUB_AUTH_MODE=trust`** → **v1 では WARN-only で許容** (= 起動成功、v2 で hard reject 予告)、
 *        `AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1` 明示時は audit-friendly な opt-in WARN に切替え
 *      - **PE + `AGENT_HUB_AUTH_MODE=pat`** → 設計矛盾、常に `EditionConfigError` で hard reject
 *      - 未指定なら edition から auto-derive
 *   5. CE 固有 flag (`AGENT_HUB_DISABLE_DEFAULT_TENANT`) は PE で設定されていたら
 *      WARN log を出力 (silent ignore 廃止、設定意図の自覚を促す)
 *
 * 副作用: 上記 (4) CE+trust path と (5) PE+restriction path で `console.warn` を出力する。
 * 例外は `EditionConfigError` のみ (= 設計矛盾 path のみ throw)。
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

  const authModeRawRaw = env.AGENT_HUB_AUTH_MODE?.trim().toLowerCase();
  const authModeExplicit: AuthMode | null =
    authModeRawRaw === 'trust' || authModeRawRaw === 'pat' ? authModeRawRaw : null;
  if (authModeRawRaw && authModeExplicit === null) {
    throw new EditionConfigError(
      `AGENT_HUB_AUTH_MODE='${authModeRawRaw}' は未知の値です。'trust' か 'pat' を指定してください。`
    );
  }

  let authMode: AuthMode;
  if (edition === 'community') {
    // CE は PAT 必須が default、AGENT_HUB_AUTH_MODE=trust 明示 (= v1 では legacy 経路) を WARN-only で許容。
    // v2 で hard reject される予定。AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1 で v2 まで延命可能。
    if (authModeExplicit === 'trust') {
      const optIn = env.AGENT_HUB_ALLOW_LEGACY_CE_TRUST === '1';
      if (optIn) {
        console.warn(
          '[edition] legacy CE+trust mode running under explicit opt-in ' +
            "(AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1)。v2 でも WARN-only で延命されますが、" +
            'PAT 認証への移行を推奨します (= AGENT_HUB_AUTH_MODE=pat または AGENT_HUB_EDITION=private)。'
        );
      } else {
        console.warn(
          '[edition] AGENT_HUB_EDITION=community で AGENT_HUB_AUTH_MODE=trust は次バージョン (v2) から ' +
            "reject されます。LAN 専用運用なら AGENT_HUB_EDITION=private を、" +
            'PAT 認証で公開運用なら AGENT_HUB_AUTH_MODE=pat を指定してください。' +
            '現バージョン中の延命が必要な場合は AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1 を設定してください (opt-in)。'
        );
      }
      authMode = 'trust';
    } else {
      authMode = 'pat';
    }
  } else {
    // PE は trust 固定。AGENT_HUB_AUTH_MODE=pat を明示されたら設計矛盾として hard reject。
    if (authModeExplicit === 'pat') {
      throw new EditionConfigError(
        'AGENT_HUB_EDITION=private で AGENT_HUB_AUTH_MODE=pat は使用できません。' +
          ' LAN 専用運用なら AGENT_HUB_AUTH_MODE 指定を削除 (PE は trust 固定)、' +
          ' PAT 認証で公開運用なら AGENT_HUB_EDITION=community を指定してください。'
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
  // `AGENT_HUB_DISABLE_DEFAULT_TENANT` は意味を持たないが、設定意図の自覚を促すため WARN log を出す
  // (silent ignore 廃止、Minor 4 反映)。
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
