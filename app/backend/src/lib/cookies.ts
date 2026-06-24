import { type Request, type Response } from "express";
import { config } from "../config";

const COOKIE_NAME = "sid";
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.NODE_ENV === "production",
    signed: true,
    path: "/",
  };
}

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(COOKIE_NAME, sessionId, {
    ...baseCookieOptions(),
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function readSessionCookie(req: Request): string | undefined {
  const value = req.signedCookies[COOKIE_NAME];
  return typeof value === "string" ? value : undefined;
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, baseCookieOptions());
}
