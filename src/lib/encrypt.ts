import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM — TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes).
// In local dev without the key, tokens are stored as plaintext (never in production).
const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY ?? "";

export function encrypt(plaintext: string): string {
  if (!KEY_HEX) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TOKEN_ENCRYPTION_KEY is required in production");
    }
    return plaintext;
  }
  const key = Buffer.from(KEY_HEX, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: iv(12) | tag(16) | ciphertext — base64 encoded
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  if (!KEY_HEX) return ciphertext;
  const buf = Buffer.from(ciphertext, "base64");
  const key = Buffer.from(KEY_HEX, "hex");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}
