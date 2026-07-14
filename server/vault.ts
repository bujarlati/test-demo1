import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirectory } from "./storage";

interface SecretRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

type SecretStore = Record<string, SecretRecord>;

const secretFile = path.join(dataDirectory, "secrets.json");
const developmentKeyFile = path.join(dataDirectory, ".master-key");

function parseEnvironmentKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值。");
  }
  return key;
}

async function loadMasterKey(): Promise<Buffer> {
  const configured = process.env.APP_ENCRYPTION_KEY?.trim();
  if (configured) {
    return parseEnvironmentKey(configured);
  }

  await mkdir(dataDirectory, { recursive: true });
  try {
    return Buffer.from((await readFile(developmentKeyFile, "utf8")).trim(), "base64");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
    const key = randomBytes(32);
    await writeFile(developmentKeyFile, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }
}

async function readSecrets(): Promise<SecretStore> {
  try {
    return JSON.parse(await readFile(secretFile, "utf8")) as SecretStore;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (missing) {
      return {};
    }
    throw error;
  }
}

export async function storeSecret(id: string, value: string): Promise<string> {
  const key = await loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const secrets = await readSecrets();
  secrets[id] = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await writeFile(secretFile, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
  return `vault://model-connections/${id}`;
}

export async function readSecret(id: string): Promise<string> {
  const secrets = await readSecrets();
  const record = secrets[id];
  if (!record) {
    throw new Error("连接凭据不存在，请重新保存 API Key。");
  }
  const key = await loadMasterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
