import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirectory, usesPersistentStorage } from "./storage";

interface SecretRecord {
  iv: string;
  tag: string;
  ciphertext: string;
}

type SecretStore = Record<string, SecretRecord>;

const secretFile = path.join(dataDirectory, "secrets.json");
const developmentKeyFile = path.join(dataDirectory, ".master-key");
let masterKeyPromise: Promise<Buffer> | null = null;
let secretSaveQueue = Promise.resolve();
let inMemorySecrets: SecretStore = {};

function parseEnvironmentKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值。");
  }
  return key;
}

async function resolveMasterKey(): Promise<Buffer> {
  const configured = process.env.APP_ENCRYPTION_KEY?.trim();
  if (configured) {
    return parseEnvironmentKey(configured);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须设置 APP_ENCRYPTION_KEY，拒绝把模型密钥绑定到本地临时主密钥。");
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

async function loadMasterKey(): Promise<Buffer> {
  masterKeyPromise ??= resolveMasterKey();
  return Buffer.from(await masterKeyPromise);
}

async function readSecrets(): Promise<SecretStore> {
  if (!usesPersistentStorage()) return structuredClone(inMemorySecrets);
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

async function saveSecrets(secrets: SecretStore): Promise<void> {
  if (!usesPersistentStorage()) {
    inMemorySecrets = structuredClone(secrets);
    return;
  }
  const temporaryPath = `${secretFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, secretFile);
}

export async function storeSecret(id: string, value: string): Promise<{ secretRef: string; version: number }> {
  const key = await loadMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const record = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  let version = 0;
  secretSaveQueue = secretSaveQueue.catch(() => undefined).then(async () => {
    const secrets = await readSecrets();
    const versions = Object.keys(secrets)
      .map((key) => key.match(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:v(\\d+)$`))?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    version = Math.max(secrets[id] ? 1 : 0, ...versions, 0) + 1;
    secrets[`${id}:v${version}`] = record;
    await saveSecrets(secrets);
  });
  await secretSaveQueue;
  return { secretRef: `vault://model-connections/${id}/versions/${version}`, version };
}

export async function readSecret(id: string, version?: number): Promise<string> {
  const secrets = await readSecrets();
  const record = version ? secrets[`${id}:v${version}`] ?? (version === 1 ? secrets[id] : undefined) : secrets[id] ?? Object.entries(secrets)
    .filter(([key]) => key.startsWith(`${id}:v`))
    .sort(([left], [right]) => Number(right.split(":v")[1]) - Number(left.split(":v")[1]))[0]?.[1];
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

export async function deleteSecrets(id: string) {
  secretSaveQueue = secretSaveQueue.catch(() => undefined).then(async () => {
    const secrets = await readSecrets();
    for (const key of Object.keys(secrets)) {
      if (key === id || key.startsWith(`${id}:v`)) delete secrets[key];
    }
    await saveSecrets(secrets);
  });
  await secretSaveQueue;
}
