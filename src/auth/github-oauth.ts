/**
 * GitHub PAT (Personal Access Token) で user identity を確認する
 *
 * 方針: agent-hub は OAuth AS を実装せず、ユーザーが発行した PAT を
 * Authorization: Bearer ヘッダーで受け取り、GitHub API /user を叩いて検証する。
 *
 * メリット: agent-hub 側の実装が薄い（OAuth dance 不要）
 * デメリット: ユーザー側で PAT 発行・管理が必要（GitHub Settings → Developer settings → Personal access tokens）
 *
 * 必要な PAT scope:
 * - `read:user` (基本の user info)
 * - `read:org` (Org membership 検証する場合のみ)
 */

const GITHUB_API_BASE = 'https://api.github.com';

export interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
}

/** PAT で user info を取得 */
export async function fetchUserInfo(pat: string): Promise<GithubUser> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-hub',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub user fetch failed: ${res.status}`);
  }
  return (await res.json()) as GithubUser;
}

/** PAT でユーザーの所属 Org を取得 */
export async function fetchUserOrgs(pat: string): Promise<string[]> {
  const res = await fetch(`${GITHUB_API_BASE}/user/orgs`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agent-hub',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub orgs fetch failed: ${res.status}`);
  }
  const orgs = (await res.json()) as Array<{ login: string }>;
  return orgs.map((o) => o.login);
}

/** Org membership 検証。requiredOrg が未指定なら常に許可 */
export function verifyOrgMembership(
  orgs: string[],
  requiredOrg: string | undefined
): boolean {
  if (!requiredOrg) return true;
  return orgs.includes(requiredOrg);
}
