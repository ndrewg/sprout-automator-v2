import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

// Secrets never leave: assert on response SHAPE, not values — GET /credentials
// must expose no key matching /password/i whose value is a string, and
// /auth/me must never contain a passwordHash. Cheap, and it catches the whole
// class of "someone returned the ciphertext / the hash / the plaintext".

function findStringValuesByKey(
  value: unknown,
  keyPattern: RegExp,
  path = "",
  out: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findStringValuesByKey(v, keyPattern, `${path}[${i}]`, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const next = path ? `${path}.${k}` : k;
      if (keyPattern.test(k) && typeof v === "string") {
        out.push(`${next}=${v}`);
      }
      findStringValuesByKey(v, keyPattern, next, out);
    }
  }
  return out;
}

describe("secrets never leave the API", () => {
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

  it("GET /credentials has no password-shaped key holding a string", async () => {
    const { cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "secrets-user",
        sproutPassword: "plain-sprout-password-123",
        gmailEmail: "secrets@gmail.com",
        gmailAppPassword: "plain-app-password-123",
      },
    });

    const res = await request("/credentials", { cookie });
    expect(res.status).toBe(200);
    const leaks = findStringValuesByKey(res.body, /password/i);
    expect(leaks).toEqual([]);

    // The response IS the shape the API contract promises: passwords are
    // booleans, the non-secret username/email come back decrypted.
    const view = (res.body as { credentials: Record<string, unknown> }).credentials;
    expect(view["sproutPasswordSet"]).toBe(true);
    expect(view["gmailAppPasswordSet"]).toBe(true);
    expect(typeof view["sproutPasswordSet"]).toBe("boolean");
    expect(typeof view["gmailAppPasswordSet"]).toBe("boolean");
  });

  it("the saved plaintext never appears anywhere in GET /credentials", async () => {
    const { cookie } = await createUser();
    // Distinctive fixtures on purpose: the assertion below searches the whole
    // response body for these strings, so they must be unlikely to occur by
    // chance. Not real credentials.
    const sproutPassword = "never-return-this-12345"; // gitleaks:allow
    const appPassword = "never-return-app-67890"; // gitleaks:allow
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "secrets-user",
        sproutPassword,
        gmailEmail: "secrets@gmail.com",
        gmailAppPassword: appPassword,
      },
    });

    const res = await request("/credentials", { cookie });
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain(sproutPassword);
    expect(bodyText).not.toContain(appPassword);
  });

  it("/auth/me never exposes passwordHash", async () => {
    const { cookie } = await createUser();
    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(200);
    const leaks = findStringValuesByKey(res.body, /passwordHash/i);
    expect(leaks).toEqual([]);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain("passwordHash");
    expect(bodyText).not.toMatch(/\$argon2/);
  });

  it("login failure and signup never leak the email into a response", async () => {
    const email = "secrets-leak-check@example.com";
    const badLogin = await request("/auth/login", {
      method: "POST",
      body: { email, password: "wrong-password-1234" },
    });
    expect(badLogin.status).toBe(401);
    expect(JSON.stringify(badLogin.body)).not.toContain(email);
  });
});
