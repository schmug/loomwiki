// SPDX-License-Identifier: Apache-2.0

// Cloudflare Access JWT verification.
//
// Cache JWKS in KV for 24h (M1 prompt's resolved decision). Without the cache
// every authenticated request blocks on a fetch to cloudflareaccess.com — with
// it, validation is sub-millisecond.
//
// Reference: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

import { ErrorCodes, LoomwikiError } from "@loomwiki/shared";
import * as jose from "jose";
import type { Env } from "../env.js";

const JWKS_TTL_SECONDS = 60 * 60 * 24; // 24h
const JWKS_KV_KEY_PREFIX = "access-jwks:";

export interface AccessClaims {
  email: string;
  sub: string;
  exp: number;
}

function teamIssuer(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

function jwksUrl(team: string): string {
  return `${teamIssuer(team)}/cdn-cgi/access/certs`;
}

/**
 * Returns the team's JWKS, reading from KV cache when fresh and falling back
 * to a network fetch otherwise. Errors throw `INTERNAL_ERROR` (500) — these
 * are misconfigurations or upstream outages, not client problems.
 */
export async function getAccessJwks(env: Env): Promise<jose.JSONWebKeySet> {
  const team = env.ACCESS_TEAM;
  if (!team) {
    throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "ACCESS_TEAM env var is not set", {
      status: 500,
    });
  }

  const cacheKey = `${JWKS_KV_KEY_PREFIX}${team}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return cached as jose.JSONWebKeySet;

  const res = await fetch(jwksUrl(team), { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new LoomwikiError(
      ErrorCodes.INTERNAL_ERROR,
      `Failed to fetch Access JWKS (HTTP ${res.status})`,
      { status: 500 },
    );
  }
  const jwks = (await res.json()) as jose.JSONWebKeySet;
  await env.CACHE.put(cacheKey, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_SECONDS });
  return jwks;
}

export async function invalidateAccessJwks(env: Env): Promise<void> {
  const team = env.ACCESS_TEAM;
  if (!team) return;
  await env.CACHE.delete(`${JWKS_KV_KEY_PREFIX}${team}`);
}

/**
 * Verifies a Cloudflare Access JWT against the team's JWKS.
 *
 * Distinguishes expired (`AUTH_EXPIRED`) from other invalid-JWT cases
 * (`AUTH_INVALID_JWT`) so the client can surface different UX (silently
 * re-auth on expired vs. show an error on tampered).
 */
export async function verifyAccessJwt(env: Env, token: string): Promise<AccessClaims> {
  const team = env.ACCESS_TEAM;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) {
    throw new LoomwikiError(ErrorCodes.INTERNAL_ERROR, "Access auth not configured", {
      status: 500,
    });
  }

  const jwks = await getAccessJwks(env);
  const resolver = jose.createLocalJWKSet(jwks);

  let payload: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, resolver, {
      audience: aud,
      issuer: teamIssuer(team),
    });
    payload = result.payload;
  } catch (cause) {
    if (cause instanceof jose.errors.JWTExpired) {
      throw new LoomwikiError(ErrorCodes.AUTH_EXPIRED, "JWT has expired", {
        status: 401,
        cause,
      });
    }
    throw new LoomwikiError(ErrorCodes.AUTH_INVALID_JWT, "Invalid Access JWT", {
      status: 401,
      cause,
    });
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) {
    throw new LoomwikiError(ErrorCodes.AUTH_INVALID_JWT, "JWT missing email claim", {
      status: 401,
    });
  }
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    throw new LoomwikiError(ErrorCodes.AUTH_INVALID_JWT, "JWT missing sub claim", {
      status: 401,
    });
  }

  return { email, sub, exp: typeof payload.exp === "number" ? payload.exp : 0 };
}
