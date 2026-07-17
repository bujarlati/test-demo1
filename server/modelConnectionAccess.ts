import type {
  AppStore,
  GenerationModelOption,
  ModelConnection,
  ModelConnectionStatus,
  UserAccount,
} from "../src/types";

export function connectionStatusAfterTestFailure(error: unknown): ModelConnectionStatus {
  const providerStatus = error && typeof error === "object" && "providerStatus" in error
    ? Number((error as { providerStatus?: unknown }).providerStatus)
    : undefined;
  if (providerStatus === 401) return "revoked";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:invalid|expired|revoked)\s+(?:api\s*)?key|unauthori[sz]ed|凭据(?:无效|失效|过期|已撤销)|密钥(?:无效|失效|过期|已撤销)/i.test(message)
    ? "revoked"
    : "degraded";
}

export function isManagedLocalConnection(connection: ModelConnection): boolean {
  return connection.secretRef.startsWith("platform://managed");
}

export function listAccessibleConnections(store: AppStore, user: UserAccount): ModelConnection[] {
  return store.connections.filter((connection) =>
    connection.ownerScope === "platform" || connection.ownerId === user.id,
  );
}

export function accessibleConnectionOrThrow(
  store: AppStore,
  connectionId: string,
  user: UserAccount,
): ModelConnection {
  const connection = listAccessibleConnections(store, user).find((item) => item.id === connectionId);
  if (!connection) {
    const error = new Error("模型连接不存在或无权访问。");
    Object.assign(error, { status: 404 });
    throw error;
  }
  return connection;
}

export function listGenerationModelOptions(
  store: AppStore,
  user: UserAccount,
): GenerationModelOption[] {
  return listAccessibleConnections(store, user).map((connection) => ({
    id: connection.id,
    name: connection.name,
    status: connection.status,
    plannerModel: connection.routes.planner,
    writerModel: connection.routes.writer,
    isDefault: connection.id === user.defaultConnectionId,
    managedLocal: isManagedLocalConnection(connection),
  }));
}
