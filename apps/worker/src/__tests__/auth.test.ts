// SPDX-License-Identifier: Apache-2.0

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, clearJwksCache, resetDb } from "./__fixtures__/db.js";
import { type JwtFixture, makeJwtFixture } from "./__fixtures__/jwt.js";

let fixture: JwtFixture;

beforeAll(async () => {
  await applyMigrations();
  fixture = await makeJwtFixture();
  await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
});

beforeEach(async () => {
  await resetDb();
});

interface ErrBody {
  ok: false;
  error: { code: string; message: string };
}

async function readErr(res: Response): Promise<ErrBody> {
  return (await res.json()) as ErrBody;
}

describe("auth middleware", () => {
  it("rejects requests with no JWT (AUTH_REQUIRED, 401)", async () => {
    const res = await SELF.fetch("https://api.local/api/me");
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("accepts a valid JWT and returns 200 on /api/me", async () => {
    const jwt = await fixture.mint({ email: "alice@example.com" });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a JWT signed with the wrong key (AUTH_INVALID_JWT, 401)", async () => {
    const jwt = await fixture.mintWithRogueKey({ email: "bob@example.com" });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_INVALID_JWT");
  });

  it("rejects an expired JWT (AUTH_EXPIRED, 401)", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const jwt = await fixture.mint({ email: "carol@example.com", expSeconds: past });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_EXPIRED");
  });

  it("rejects a JWT with the wrong audience (AUTH_INVALID_JWT, 401)", async () => {
    const jwt = await fixture.mint({
      email: "dave@example.com",
      audience: "not-the-real-aud",
    });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_INVALID_JWT");
  });

  it("rejects a JWT with the wrong issuer (AUTH_INVALID_JWT, 401)", async () => {
    const jwt = await fixture.mint({
      email: "eve@example.com",
      issuer: "https://attacker.cloudflareaccess.com",
    });
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": jwt },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_INVALID_JWT");
  });

  it("rejects a malformed JWT (AUTH_INVALID_JWT, 401)", async () => {
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "CF-Access-Jwt-Assertion": "not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_INVALID_JWT");
  });
});

describe("local-dev auth bypass", () => {
  beforeEach(() => {
    env.ALLOW_LOCAL_DEV_AUTH = "false";
  });

  it("ignores X-Local-Dev-Email when ALLOW_LOCAL_DEV_AUTH is not 'true'", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "false";
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "X-Local-Dev-Email": "alice@example.com" },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("accepts X-Local-Dev-Email when the flag is on and CF-Connecting-IP is missing", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "true";
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: { "X-Local-Dev-Email": "alice@example.com" },
    });
    expect(res.status).toBe(200);
  });

  it("accepts X-Local-Dev-Email when CF-Connecting-IP is 127.0.0.1", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "true";
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: {
        "X-Local-Dev-Email": "alice@example.com",
        "CF-Connecting-IP": "127.0.0.1",
      },
    });
    expect(res.status).toBe(200);
  });

  it("rejects X-Local-Dev-Email when CF-Connecting-IP is not localhost (8.8.8.8)", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "true";
    const res = await SELF.fetch("https://api.local/api/me", {
      headers: {
        "X-Local-Dev-Email": "alice@example.com",
        "CF-Connecting-IP": "8.8.8.8",
      },
    });
    expect(res.status).toBe(401);
    const body = await readErr(res);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });
});

describe("debug invalidate-jwks", () => {
  it("returns 404 when ALLOW_LOCAL_DEV_AUTH is off", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "false";
    const res = await SELF.fetch("https://api.local/api/_debug/invalidate-jwks", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("invalidates the cached JWKS when ALLOW_LOCAL_DEV_AUTH is on", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "true";
    await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
    expect(await env.CACHE.get(`access-jwks:${env.ACCESS_TEAM}`)).not.toBeNull();

    const res = await SELF.fetch("https://api.local/api/_debug/invalidate-jwks", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    expect(await env.CACHE.get(`access-jwks:${env.ACCESS_TEAM}`)).toBeNull();

    // Re-seed for downstream tests.
    await env.CACHE.put(`access-jwks:${env.ACCESS_TEAM}`, JSON.stringify(fixture.jwks));
  });

  it("returns 404 when the IP gate fails (CF-Connecting-IP=8.8.8.8) even with the flag on", async () => {
    env.ALLOW_LOCAL_DEV_AUTH = "true";
    const res = await SELF.fetch("https://api.local/api/_debug/invalidate-jwks", {
      method: "POST",
      headers: { "CF-Connecting-IP": "8.8.8.8" },
    });
    expect(res.status).toBe(404);
  });
});

// Reference clearJwksCache so the import isn't dead — exercised by tests
// that run after this suite if needed.
void clearJwksCache;
