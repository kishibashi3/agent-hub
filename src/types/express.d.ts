// Express Request 拡張: authenticateUser middleware 通過後に
// `req.userId` (canonical handle, 常に `@<name>` 形式) と
// `req.githubLogin` (GitHub login、`@` なし) が利用可能になる。
//
// これにより `(req as any).userId` のような型安全ぶち破りを排除する。
// optional にしているのは middleware を通る前のリクエストでも型が成立するため。
// 各 handler は middleware を信用して `req.userId!` のように non-null 断定するか、
// 防御的に分岐する。

import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * canonical handle, 常に `@<name>` 形式。
     * authenticateUser middleware を通った後にセットされる。
     */
    userId?: string;
    /**
     * GitHub login (例: "kishibashi3")、`@` なし。
     * PAT モードでは PAT を verify した結果、trust モードでは X-User-Id と同じ。
     */
    githubLogin?: string;
    /**
     * tenant 識別子 (X-Tenant-Id header の値)。未指定なら 'default' (雑談室)。
     * authenticateUser middleware で TOFU + ownership check 通過後にセット。
     */
    tenantDomain?: string;
    /**
     * X-Agent-Hub-Client header の値。クライアント種別識別に使用。
     * authenticateUser middleware でセット。未送信なら null。
     * 例: "agent-hub-plugin/ope-ultp1635", "agent-hub-bridge/claude", "agenthubctl"
     */
    clientType?: string | null;
  }
}
