import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { config } from "../../src/config";
import {
  encrypt,
  decrypt,
  encryptOptional,
  decryptOptional,
} from "../../src/lib/encryption";

const KEY = Buffer.from(config.APP_ENCRYPTION_KEY, "hex");

describe("encryption (AES-256-GCM)", () => {
  it("round-trips plaintext", () => {
    const secret = "hunter2-Ñoño-🌱-長い文字列";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertext for the same input (random IV)", () => {
    const a = encrypt("same-input");
    const b = encrypt("same-input");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same-input");
    expect(decrypt(b)).toBe("same-input");
  });

  it("throws if any byte is flipped (auth tag rejects tampering)", () => {
    const token = encrypt("tamper-me");
    const buf = Buffer.from(token, "base64url");
    // Flip a bit in the final ciphertext byte.
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0x01;
    const tampered = buf.toString("base64url");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects an unsupported version byte", () => {
    const token = encrypt("versioned");
    const buf = Buffer.from(token, "base64url");
    buf[0] = 0x02; // bump version
    const bad = buf.toString("base64url");
    expect(() => decrypt(bad)).toThrow(/unsupported ciphertext version/);
  });

  it("rejects a too-short ciphertext", () => {
    expect(() => decrypt("AAAA")).toThrow(/too short/);
  });

  it("rejects a truncated authentication tag", () => {
    // Build a payload whose auth tag is only 8 bytes (GCM permits 4–16). The
    // ciphertext is long enough that the fixed tag slice [13,29) is a
    // truncated tag + ciphertext bytes — so this exercises the tag/auth path,
    // not the too-short length check.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 8 });
    const ct = Buffer.concat([
      cipher.update("truncated-tag-payload-with-enough-ciphertext", "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag(); // 8 bytes, valid for this ciphertext
    const payload = Buffer.concat([Buffer.from([0x01]), iv, tag, ct]);
    expect(() => decrypt(payload.toString("base64url"))).toThrow();
  });

  it("encryptOptional treats null/empty as cleared", () => {
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional(undefined)).toBeNull();
    expect(encryptOptional("")).toBeNull();
    const enc = encryptOptional("value");
    expect(enc).not.toBeNull();
    expect(decryptOptional(enc)).toBe("value");
    expect(decryptOptional(null)).toBeNull();
  });
});
