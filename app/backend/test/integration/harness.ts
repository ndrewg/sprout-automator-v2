import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { app } from "../../src/app";
import { db, pool } from "../../src/db/client";
import type { User } from "../../src/db/schema";

// Integration harness: real Express app on an ephemeral port + real Postgres
// (sprout_test). Everything routes through the actual HTTP stack so cookies,
// sessions, Argon2, and the signed sid cookie are all exercised — not fixtures.

type Cookie = string;

export type TestUser = { user: User; cookie: Cookie };

export type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

let server: TestServer | null = null;

// --- Database ---------------------------------------------------------------

/**
 * Global setup: run the real Drizzle migrator against the test database.
 * Same migrate() as src/db/migrate.ts — never hand-write schema in tests (a
 * drifted test schema is worse than no test). Fails loudly if the database is
 * unreachable so a missing `docker compose up -d postgres` is obvious.
 */
export async function setupDatabase(): Promise<void> {
  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Integration test database unreachable (is Postgres running? ` +
        `\`docker compose up -d postgres\`). Underlying error: ${message}`,
    );
  }
}

/**
 * Between tests: wipe every table, cascading from users. Fast and total.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    TRUNCATE users, runs, sessions, credentials, schedules, audit_log
    RESTART IDENTITY CASCADE
  `);
}

// --- Server -----------------------------------------------------------------

/**
 * Boot the real app on an ephemeral port. One server per file (via
 * beforeAll), not per test.
 */
export async function startTestServer(): Promise<TestServer> {
  if (server) return server;
  const instance = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, () => resolve(s));
    s.on("error", reject);
  });
  const address = instance.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  server = {
    baseUrl,
    close: async () => {
      // fetch keeps alive by default; force-close so server.close() resolves.
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
      server = null;
    },
  };
  return server;
}

// --- Auth -------------------------------------------------------------------

/**
 * Sign up through the REAL POST /auth/signup route and return the signed sid
 * cookie. Going through the route exercises Argon2, session creation, and the
 * signed cookie rather than a fixture that can drift from them.
 */
export async function createUser(opts?: {
  email?: string;
  password?: string;
}): Promise<TestUser> {
  const email =
    opts?.email ?? `user-${randomUUID().slice(0, 8)}@example.com`;
  const password = opts?.password ?? "integration-pass-1234";
  const baseUrl = await serverBaseUrl();
  const res = await fetch(`${baseUrl}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 201) {
    throw new Error(`createUser: signup returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { user: User };
  const cookie = extractSidCookie(res.headers.get("set-cookie"));
  if (!cookie) throw new Error("createUser: signup did not set a sid cookie");
  return { user: body.user, cookie };
}

// --- Request helper ---------------------------------------------------------

export type TestResponse = {
  status: number;
  body: unknown;
  headers: Headers;
};

/**
 * Thin fetch wrapper. Sends the sid cookie when given. Returns status + body
 * so every route test asserts on both.
 */
export async function request(
  path: string,
  opts?: { cookie?: Cookie; method?: string; body?: unknown },
): Promise<TestResponse> {
  const baseUrl = await serverBaseUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts?.cookie) headers["Cookie"] = opts.cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts?.method ?? "GET",
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    headers: res.headers,
  };
}

// --- Internals --------------------------------------------------------------

async function serverBaseUrl(): Promise<string> {
  if (!server) throw new Error("startTestServer() must be called first");
  return server.baseUrl;
}

function extractSidCookie(setCookie: string | null): Cookie | undefined {
  if (!setCookie) return undefined;
  const first = setCookie.split(",")[0];
  const match = first?.match(/^sid=([^;]+)/);
  return match?.[1] ? `sid=${match[1]}` : undefined;
}

export async function closeTestServer(): Promise<void> {
  if (server) await server.close();
  await pool.end().catch(() => {});
}
