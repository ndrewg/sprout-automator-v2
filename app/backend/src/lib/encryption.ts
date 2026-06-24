import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config";

// AES-256-GCM. Payload format: base64url( v1 || iv(12) || tag(16) || ciphertext )
// "v1" prefix byte (0x01) makes future key/algorithm rotation explicit.

const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY = Buffer.from(config.APP_ENCRYPTION_KEY, "hex");
if (KEY.length !== 32) {
  throw new Error(
    "APP_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars)",
  );
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
  return payload.toString("base64url");
}

export function decrypt(token: string): string {
  const buf = Buffer.from(token, "base64url");
  if (buf.length < 1 + IV_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const version = buf[0];
  if (version !== VERSION) {
    throw new Error(`unsupported ciphertext version: ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptOptional(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  return encrypt(value);
}

export function decryptOptional(token: string | null | undefined): string | null {
  if (token == null || token === "") return null;
  return decrypt(token);
}
