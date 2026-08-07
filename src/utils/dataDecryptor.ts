import { decryptValue } from "./dataEncryption";

export type DecryptedPayload = Buffer | string | Record<string, unknown> | unknown[] | number | boolean | null;

export function decryptPayloadValue<T = DecryptedPayload>(encryptedPayload: string): T {
  if (!encryptedPayload || !encryptedPayload.trim()) {
    throw new Error("Encrypted payload is required");
  }

  return decryptValue(encryptedPayload.trim()) as T;
}

export function decryptPayloadText(encryptedPayload: string): string {
  const decrypted = decryptPayloadValue(encryptedPayload);

  if (Buffer.isBuffer(decrypted)) {
    return decrypted.toString("utf8");
  }

  if (typeof decrypted === "string") {
    return decrypted;
  }

  if (decrypted === null || decrypted === undefined) {
    return "";
  }

  return JSON.stringify(decrypted, null, 2);
}