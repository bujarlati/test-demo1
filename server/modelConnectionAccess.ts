import type {
  AppStore,
  GenerationModelOption,
  ModelConnection,
  UserAccount,
} from "../src/types";

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
