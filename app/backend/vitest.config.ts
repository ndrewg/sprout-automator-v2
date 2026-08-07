import { defineConfig } from "vitest/config";

// Tests import modules that load `config.ts`, which Zod-validates the env at
// import time. Supply a self-contained test env so unit tests need no real
// .env / database. These values are dummies — never real secrets.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_ENCRYPTION_KEY: "0".repeat(64),
      SESSION_SECRET: "x".repeat(48),
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      // Signup allowlist for the test environment (§4A.2): the harness signs
      // every test user up through the REAL /auth/signup route with an
      // @example.com address, so the allowlist must admit example.com.
      // Deliberately capital-E: it doubles as the case-insensitivity proof for
      // the allowlist side, since the harness emails are lowercase.
      SIGNUP_ALLOWED: "Example.com, maz.getutua@gmail.com",
    },
  },
});
