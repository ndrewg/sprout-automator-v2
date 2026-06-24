import { describe, it, expect } from "vitest";
import { encrypt, decrypt, encryptOptional, decryptOptional } from "./encryption";

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
