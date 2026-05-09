/**
 * JWT 発行と検証
 *
 * agent-hub は GitHub OAuth で identity を確認した後、自分の署名で JWT を発行する。
 * 以降のリクエストは `Authorization: Bearer <jwt>` で認証される。
 *
 * 委任トークンも同じ仕組みで、claim に `delegation_parent` を載せて区別する。
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const ALG = 'HS256';

/** 環境変数から署名鍵を取得（無ければ起動失敗）*/
function getSecret(): Uint8Array {
  const s = process.env.JWT_SIGNING_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'JWT_SIGNING_SECRET is not set or too short (min 32 chars). ' +
        'Set it as an environment variable: ' +
        'JWT_SIGNING_SECRET=$(openssl rand -hex 32)'
    );
  }
  return new TextEncoder().encode(s);
}

/** session token に載せるクレーム */
export interface SessionClaims extends JWTPayload {
  /** @ なしのユーザー識別子 */
  sub: string;
  /** identity provider（"github" など）*/
  idp?: string;
  /** OAuth provider 内の user id */
  idp_subject?: string;
  /** 委任元（@ なし）— 通常の人間ユーザーは undefined */
  delegation_parent?: string;
}

/** session token を発行する */
export async function signSessionToken(
  claims: SessionClaims,
  expiresInSeconds = 60 * 60 * 24 * 7 // 7 日
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG })
    .setIssuer('agent-hub')
    .setAudience('agent-hub')
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(getSecret());
}

/** session token を検証する。失敗時は throw */
export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    issuer: 'agent-hub',
    audience: 'agent-hub',
  });
  if (typeof payload.sub !== 'string') {
    throw new Error('jwt: sub claim missing');
  }
  return payload as SessionClaims;
}
