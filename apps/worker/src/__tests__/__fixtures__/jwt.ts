// SPDX-License-Identifier: Apache-2.0

// JWT fixture for auth tests. Generates an RSA keypair at fixture-load time
// and exposes a `mintTestJwt` helper. Tests seed the public key into KV
// (`access-jwks:<team>`) so verifyAccessJwt() reads from cache and never
// fetches the real Access JWKS endpoint.

import * as jose from "jose";

const KID = "loomwiki-test-key";

export interface MintOptions {
  email: string;
  sub?: string;
  audience?: string;
  issuer?: string;
  /** Pass an absolute epoch (seconds) to make the token expired or far-future. */
  expSeconds?: number;
  /** Override `kid` to test the wrong-key path. */
  kid?: string;
}

export interface JwtFixture {
  jwks: jose.JSONWebKeySet;
  mint(opts: MintOptions): Promise<string>;
  /** Sign with a different (untrusted) keypair; useful for invalid-signature tests. */
  mintWithRogueKey(opts: MintOptions): Promise<string>;
}

async function exportPublicJwk(publicKey: jose.KeyLike, kid: string): Promise<jose.JWK> {
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return jwk;
}

export async function makeJwtFixture(): Promise<JwtFixture> {
  const trusted = await jose.generateKeyPair("RS256", { extractable: true });
  const rogue = await jose.generateKeyPair("RS256", { extractable: true });
  const trustedJwk = await exportPublicJwk(trusted.publicKey, KID);
  const jwks: jose.JSONWebKeySet = { keys: [trustedJwk] };

  function buildBuilder(opts: MintOptions): jose.SignJWT {
    const issuer = opts.issuer ?? "https://loomwiki-dev.cloudflareaccess.com";
    const audience = opts.audience ?? "loomwiki-dev-aud";
    const sub = opts.sub ?? "test-sub";
    const builder = new jose.SignJWT({ email: opts.email })
      .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt();
    if (opts.expSeconds !== undefined) builder.setExpirationTime(opts.expSeconds);
    else builder.setExpirationTime("5m");
    return builder;
  }

  return {
    jwks,
    async mint(opts) {
      return buildBuilder(opts).sign(trusted.privateKey);
    },
    async mintWithRogueKey(opts) {
      return buildBuilder(opts).sign(rogue.privateKey);
    },
  };
}
