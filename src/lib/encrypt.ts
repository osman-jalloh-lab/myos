import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM — TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes).
// Required in ALL environments — no plaintext token storage, ever.
// Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY ?? "";

function requireKey(): Buffer {
  if (!KEY_HEX) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. " +
      "Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      "and add it to .env.local and Vercel env vars."
    );
  }
  if (KEY_HEX.length !== 64) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Got ${KEY_HEX.length} characters.`
    );
  }
  return Buffer.from(KEY_HEX, "hex");
}

export function encrypt(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: iv(12) | tag(16) | ciphertext — base64 encoded
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  // Detect plaintext tokens from before encryption was enforced.
  // If it doesn't decode as valid base64 with the right minimum length, it's plaintext.
  try {
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < 29) {
      // Too short to be a valid AES-GCM ciphertext — treat as legacy plaintext
      console.warn("[encrypt] Found legacy plaintext token — re-encrypt on next login");
      return ciphertext;
    }
    const key = requireKey();
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString("utf8") + decipher.final("utf8");
  } catch {
    // Decryption failed — could be a legacy plaintext token
    console.warn("[encrypt] Decrypt failed — treating as legacy plaintext token");
    return ciphertext;
  }
}
