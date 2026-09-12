import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * peer howto の MCP resource URI (issue #340)。
 * `inbox://` と同じ resources/list・resources/read・resources/subscribe の
 * 仕組みに乗る static resource（tenant / owner に依存しない単一コンテンツ）。
 */
export const HOWTO_RESOURCE_URI = 'howto://agent-hub';

/**
 * register レスポンスに埋め込む 1 行要約 (issue #340 §2b)。
 * resource read を実装していない peer でも register を呼べば必ず目に入る保険。
 */
export const HOWTO_DIGEST_SUMMARY =
  '要点: DM 返信は caused_by 必須 / @scheduler は / コマンド専用 (自由文不可) / blocking 待機禁止 (→ @scheduler /run_in) / 返信先は本文の指定を優先。詳細: howto://agent-hub';

const HOWTO_DOC_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'peer-howto.md'
);

/** `docs/peer-howto.md` の内容をそのまま返す（正本は filesystem 側、server は読むだけ）。 */
export function readHowtoDoc(): string {
  return readFileSync(HOWTO_DOC_PATH, 'utf-8');
}
