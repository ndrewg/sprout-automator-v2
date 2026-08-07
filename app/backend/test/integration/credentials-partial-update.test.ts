import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeTestServer,
  createUser,
  request,
  resetDatabase,
  setupDatabase,
  startTestServer,
} from "./harness";

type CredentialsView = {
  sproutUsername: string | null;
  sproutPasswordSet: boolean;
  gmailEmail: string | null;
  gmailAppPasswordSet: boolean;
  updatedAt: string | null;
};

function view(body: unknown): CredentialsView {
  return (body as { credentials: CredentialsView }).credentials;
}

// Credential partial-update semantics: omitted = leave unchanged, string =
// set, null = clear. Assert each field independently so "setting one wipes
// another" cannot pass.
describe("credential partial-update", () => {
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

  it("setting all four fields persists every one", async () => {
    const { cookie } = await createUser();
    const res = await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "user-one",
        sproutPassword: "pass-one-1234",
        gmailEmail: "one@gmail.com",
        gmailAppPassword: "app-one-1234",
      },
    });
    expect(res.status).toBe(200);
    const v = view(res.body);
    expect(v.sproutUsername).toBe("user-one");
    expect(v.sproutPasswordSet).toBe(true);
    expect(v.gmailEmail).toBe("one@gmail.com");
    expect(v.gmailAppPasswordSet).toBe(true);
  });

  it("omitting a field leaves it unchanged", async () => {
    const { cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "user-one",
        sproutPassword: "pass-one-1234",
        gmailEmail: "one@gmail.com",
        gmailAppPassword: "app-one-1234",
      },
    });

    // Update ONLY the username. The password, gmail email and app password
    // must survive untouched.
    const res = await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "user-two" },
    });
    expect(res.status).toBe(200);
    const v = view(res.body);
    expect(v.sproutUsername).toBe("user-two");
    expect(v.sproutPasswordSet).toBe(true);
    expect(v.gmailEmail).toBe("one@gmail.com");
    expect(v.gmailAppPasswordSet).toBe(true);

    // And on the wire, the unchanged password is still never revealed.
    const getRes = await request("/credentials", { cookie });
    expect(JSON.stringify(getRes.body)).not.toContain("pass-one-1234");
  });

  it("null clears exactly the field it is sent on", async () => {
    const { cookie } = await createUser();
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: {
        sproutUsername: "user-one",
        sproutPassword: "pass-one-1234",
        gmailEmail: "one@gmail.com",
        gmailAppPassword: "app-one-1234",
      },
    });

    // Clear the sprout password only.
    const res = await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutPassword: null },
    });
    expect(res.status).toBe(200);
    const v = view(res.body);
    expect(v.sproutPasswordSet).toBe(false);
    expect(v.sproutUsername).toBe("user-one");
    expect(v.gmailEmail).toBe("one@gmail.com");
    expect(v.gmailAppPasswordSet).toBe(true);

    // Clear the gmail app password too — username and sprout-password-state
    // must be untouched by that call.
    const res2 = await request("/credentials", {
      cookie,
      method: "PUT",
      body: { gmailAppPassword: null },
    });
    const v2 = view(res2.body);
    expect(v2.gmailAppPasswordSet).toBe(false);
    expect(v2.sproutUsername).toBe("user-one");
    expect(v2.sproutPasswordSet).toBe(false);
    expect(v2.gmailEmail).toBe("one@gmail.com");
  });

  it("each field's set/clear is independent of the others", async () => {
    const { cookie } = await createUser();
    // First touch: only the username.
    await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutUsername: "solo-user" },
    });
    // Then set only the password.
    const res = await request("/credentials", {
      cookie,
      method: "PUT",
      body: { sproutPassword: "solo-pass-1234" },
    });
    const v = view(res.body);
    expect(v.sproutPasswordSet).toBe(true);
    expect(v.sproutUsername).toBe("solo-user");
    expect(v.gmailEmail).toBeNull();
    expect(v.gmailAppPasswordSet).toBe(false);
  });

  it("empty body returns 400 No fields to update", async () => {
    const { cookie } = await createUser();
    const res = await request("/credentials", {
      cookie,
      method: "PUT",
      body: {},
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "No fields to update" });
  });
});
