import { hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const applicationDataDirectory = process.env.XUMO_DATA_DIRECTORY?.trim()
  || (process.env.NODE_ENV === "production" ? "/tmp/xumo-data" : path.join(process.cwd(), "server", "data"));
const developmentKeyFile = path.join(applicationDataDirectory, ".master-key");
let masterKeyPromise: Promise<Buffer> | null = null;

export type ApplicationEncryptionKeyLoader = () => Promise<Buffer>;

export function parseApplicationEncryptionKey(value: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY 必须是 32 字节 Base64 或 64 位十六进制值。");
  }
  return key;
}

function usesPersistentKeyStorage(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
    || process.env.XUMO_STORAGE_MODE?.trim().toLowerCase() !== "memory";
}

async function resolveApplicationEncryptionKey(): Promise<Buffer> {
  const configured = process.env.APP_ENCRYPTION_KEY?.trim();
  if (configured) return parseApplicationEncryptionKey(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须设置 APP_ENCRYPTION_KEY，拒绝把敏感数据绑定到本地临时主密钥。");
  }

  if (!usesPersistentKeyStorage()) return randomBytes(32);
  await mkdir(applicationDataDirectory, { recursive: true });
  try {
    const key = Buffer.from((await readFile(developmentKeyFile, "utf8")).trim(), "base64");
    if (key.length !== 32) throw new Error("本地开发主密钥格式无效，请删除后重新生成。");
    return key;
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) throw error;
    const key = randomBytes(32);
    await writeFile(developmentKeyFile, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    return key;
  }
}

export async function loadApplicationEncryptionKey(): Promise<Buffer> {
  masterKeyPromise ??= resolveApplicationEncryptionKey();
  return Buffer.from(await masterKeyPromise);
}

export function deriveApplicationEncryptionKey(masterKey: Buffer, purpose: string): Buffer {
  if (masterKey.length !== 32) throw new Error("应用主密钥长度无效。");
  if (!purpose.trim()) throw new Error("加密用途不能为空。");
  return Buffer.from(hkdfSync(
    "sha256",
    masterKey,
    Buffer.from("xumo:application-encryption", "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

export function resetApplicationEncryptionKeyForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  masterKeyPromise = null;
}
