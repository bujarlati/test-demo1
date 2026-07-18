import type { ExperienceStagePlan, ScheduleExperienceRequest } from "./types";

export function canonicalRoleKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function normalizeRoleBindings(value: ScheduleExperienceRequest["roleBindings"]): ExperienceStagePlan["roleBindings"] {
  return {
    version: 1,
    protagonistId: value?.protagonistId ?? "",
    aliases: value?.aliases ? [...value.aliases] : [],
    counterpartIds: value?.counterpartIds ? [...value.counterpartIds] : [],
    opponentIds: value?.opponentIds ? [...value.opponentIds] : [],
    counterparts: value?.counterparts ? value.counterparts.map((item) => ({ id: item.id, aliases: [...item.aliases] })) : [],
    opponents: value?.opponents ? value.opponents.map((item) => ({ id: item.id, aliases: [...item.aliases] })) : [],
  };
}

export function validTrustedRoleBindings(value: unknown): value is ExperienceStagePlan["roleBindings"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = value as Record<string, unknown>;
  const expectedKeys = ["aliases", "counterpartIds", "counterparts", "opponentIds", "opponents", "protagonistId", "version"].sort();
  if (Object.keys(roles).sort().join("|") !== expectedKeys.join("|") || roles.version !== 1 || typeof roles.protagonistId !== "string" || !canonicalRoleKey(roles.protagonistId)) return false;
  if (!Array.isArray(roles.aliases) || !Array.isArray(roles.counterpartIds) || !Array.isArray(roles.opponentIds) || !Array.isArray(roles.counterparts) || !Array.isArray(roles.opponents)) return false;

  const stringList = (input: unknown[], requireOne = false): input is string[] => (!requireOne || input.length > 0) && input.every((item) => typeof item === "string" && !!canonicalRoleKey(item));
  if (!stringList(roles.aliases, true) || !stringList(roles.counterpartIds) || !stringList(roles.opponentIds)) return false;

  const entitiesValid = (entities: unknown[], ids: string[]): entities is Array<{ id: string; aliases: string[] }> => {
    if (!entities.every((entity) => {
      if (!entity || typeof entity !== "object" || Array.isArray(entity) || Object.keys(entity).sort().join("|") !== "aliases|id") return false;
      const item = entity as Record<string, unknown>;
      return typeof item.id === "string" && !!canonicalRoleKey(item.id) && Array.isArray(item.aliases) && stringList(item.aliases, true);
    })) return false;
    const entityIds = entities.map((entity) => (entity as { id: string }).id).sort();
    return ids.length === entities.length && [...ids].sort().join("|") === entityIds.join("|");
  };
  if (!entitiesValid(roles.counterparts, roles.counterpartIds) || !entitiesValid(roles.opponents, roles.opponentIds)) return false;

  const entities = [...roles.counterparts, ...roles.opponents];
  const identityKeys = [roles.protagonistId, ...entities.map((item) => item.id)].map(canonicalRoleKey);
  if (new Set(identityKeys).size !== identityKeys.length) return false;
  const aliasKeys = [...roles.aliases, ...entities.flatMap((item) => item.aliases)].map(canonicalRoleKey);
  if (new Set(aliasKeys).size !== aliasKeys.length) return false;
  if (aliasKeys.some((alias) => identityKeys.includes(alias))) return false;
  return true;
}
