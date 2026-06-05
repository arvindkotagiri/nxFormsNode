import crypto from "crypto";

const KEY_HEX = process.env.DATA_ENC_KEY;
if (!KEY_HEX) {
  throw new Error("DATA_ENC_KEY environment variable is required for data encryption");
}

const KEY = Buffer.from(KEY_HEX.replace(/\s+/g, ""), "hex");
if (KEY.length !== 32) {
  throw new Error("DATA_ENC_KEY must be 32 bytes (64 hex characters)");
}

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function createEnvelope(type: string, iv: Buffer, tag: Buffer, ciphertext: Buffer): string {
  return `${type}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function parseEnvelope(envelope: string): { type: string; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted payload format");
  }
  return {
    type: parts[0],
    iv: Buffer.from(parts[1], "hex"),
    tag: Buffer.from(parts[2], "hex"),
    ciphertext: Buffer.from(parts[3], "hex"),
  };
}

export function encryptValue(value: unknown): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let payload: Buffer;
  let type = "utf8";

  if (Buffer.isBuffer(value)) {
    payload = value;
    type = "bin";
  } else if (typeof value === "object" && value !== null) {
    payload = Buffer.from(JSON.stringify(value), "utf8");
    type = "json";
  } else {
    payload = Buffer.from(String(value ?? ""), "utf8");
    type = "utf8";
  }

  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();

  return createEnvelope(type, iv, tag, ciphertext);
}

export function decryptValue(envelope: string): unknown {
  const { type, iv, tag, ciphertext } = parseEnvelope(envelope);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (type === "json") {
    return JSON.parse(decrypted.toString("utf8"));
  }
  if (type === "bin") {
    return decrypted;
  }
  return decrypted.toString("utf8");
}

export function buildEncryptedPayload(row: unknown): string {
  return encryptValue(row);
}

export function maybeDecryptPayload(payload: string | null): unknown {
  if (!payload) return null;
  return decryptValue(payload);
}
