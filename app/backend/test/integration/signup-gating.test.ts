import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/client";
import { auditLog, users } from "../../src/db/schema";
import {
  closeTestServer,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Signup gating (§4A.2): SIGNUP_ALLOWED is "Example.com, maz.getutua@gmail.com"
// in the test env — a capital-E domain entry and an exact address. The harness
// emails are lowercase, so passing these tests is also the allowlist-side
// case-insensitivity proof.

// Fixture only — must be >=12 chars to clear the signup schema. Not a secret.
const password = "signup-gate-pass-1234"; // gitleaks:allow
const genericError = "Signup is not open.";

async function signup(email: string): Promise<number> {
  return (
    await request("/auth/signup", {
      method: "POST",
      body: { email, password },
    })
  ).status;
}

describe("signup gating", () => {
  beforeAll(async () => {
    await setupDatabase();
    await startTestServer();
  });
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await closeTestServer();
  });

  it("an allowed domain signs up", async () => {
    expect(await signup("someone@example.com")).toBe(201);
  });

  it("an allowed exact address signs up (gmail.com is NOT in the allowlist)", async () => {
    expect(await signup("maz.getutua@gmail.com")).toBe(201);
  });

  it("a disallowed address is rejected with a generic 403", async () => {
    const email = "attacker@evil.com";
    const res = await request("/auth/signup", {
      method: "POST",
      body: { email, password },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: genericError });
    // The response must not reveal the allowlist or the attempted email.
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain(email);
    expect(bodyText).not.toContain("example.com");
    expect(bodyText).not.toContain("gmail.com");

    // And no user row exists.
    const [userRow] = await db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email));
    expect(userRow).toBeUndefined();
  });

  it("a subdomain of an allowed domain is rejected (whole-domain entries only)", async () => {
    expect(await signup("someone@sub.example.com")).toBe(403);
  });

  it("matching is case-insensitive", async () => {
    expect(await signup("MAZ.GETUTUA@GMAIL.COM")).toBe(201);
    expect(await signup("Someone@Example.COM")).toBe(201);
  });

  it("a rejected signup is audited as signup_rejected with an emailHash, never the email", async () => {
    const email = "leak-check@evil.com";
    const res = await request("/auth/signup", {
      method: "POST",
      body: { email, password },
    });
    expect(res.status).toBe(403);

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "signup_rejected"));
    expect(rows).toHaveLength(1);
    const metadata = rows[0]!.metadata as Record<string, unknown> | null;
    expect(metadata).toEqual({ emailHash: expect.stringMatching(/^[0-9a-f]{16}$/) });

    const metadataText = JSON.stringify(metadata);
    expect(metadataText).not.toContain(email);
    expect(metadataText).not.toContain("leak-check");
    expect(metadataText).not.toContain("example.com");
    expect(metadataText).not.toContain("gmail.com");
    expect(metadataText).not.toContain("allowlist");
  });

  it("an allowed signup is audited as signup, not signup_rejected", async () => {
    await signup("clean@example.com");
    const rejected = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "signup_rejected"));
    expect(rejected).toHaveLength(0);
    const accepted = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "signup"));
    expect(accepted).toHaveLength(1);
  });
});
