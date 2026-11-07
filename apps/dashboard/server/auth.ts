import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "./config.js";
import { settings } from "./settings.js";

const COOKIE = "t3m_session";
const MAX_AGE_S = 30 * 24 * 3600;

function sign(payload: string): string {
  return createHmac("sha256", settings.raw.sessionSecret).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function checkPassword(candidate: string): boolean {
  if (!config.adminPassword) return true;
  const a = createHmac("sha256", "pw").update(candidate).digest();
  const b = createHmac("sha256", "pw").update(config.adminPassword).digest();
  return timingSafeEqual(a, b);
}

export function issueSession(c: Context): void {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  setCookie(c, COOKIE, `${exp}.${sign(exp)}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export function isAuthenticated(c: Context): boolean {
  if (!config.adminPassword) return true;
  const raw = getCookie(c, COOKIE);
  if (!raw) return false;
  const [exp, sig] = raw.split(".");
  if (!exp || !sig || !safeEqual(sig, sign(exp))) return false;
  return Number(exp) * 1000 > Date.now();
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!isAuthenticated(c)) return c.json({ error: "Sign in required" }, 401);
  // CSRF: browsers mark cross-site requests, and HTML forms cannot send JSON,
  // so mutations must be same-site and carry a JSON content type (or no body).
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Cross-site request rejected" }, 403);
    }
    const type = c.req.header("content-type") ?? "";
    const hasBody = Number(c.req.header("content-length") ?? "0") > 0 || c.req.header("transfer-encoding");
    if (hasBody && !type.includes("application/json")) {
      return c.json({ error: "JSON body required" }, 415);
    }
  }
  await next();
};
