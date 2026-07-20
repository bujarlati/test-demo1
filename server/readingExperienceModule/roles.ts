import type { ExperienceStagePlan, ScheduleExperienceRequest } from "./types";

const MAX_ROLE_VALUE_LENGTH = 128;
const MAX_ROLE_ENTITIES = 64;
const MAX_ROLE_ALIASES = 128;
const MAX_ALIASES_PER_ENTITY = 16;
const MAX_ROLE_CHARACTER_BUDGET = 8_192;
const roleControlCharacter = /[\u0000-\u001f\u007f-\u009f]/u;
const rawRoleKeys = new Set(["version", "protagonistId", "aliases", "counterpartIds", "opponentIds", "counterparts", "opponents"]);

type NormalizedRoleBindings = ExperienceStagePlan["roleBindings"];

function dataRecord(value: unknown, allowedKeys: ReadonlySet<string>, requiredKeys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") || keys.length > allowedKeys.size) return null;
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!allowedKeys.has(key) || !("value" in descriptor) || !descriptor.enumerable) return null;
    record[key] = descriptor.value;
  }
  return requiredKeys.every((key) => Object.hasOwn(record, key)) ? record : null;
}

function boundedArrayLength(value: unknown, maximum: number, requireOne = false): number | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isInteger(lengthDescriptor.value)) return null;
  const length = lengthDescriptor.value as number;
  if (length > maximum || (requireOne && length === 0)) return null;
  return length;
}

function dataArray(value: unknown, maximum: number, requireOne = false): unknown[] | null {
  const length = boundedArrayLength(value, maximum, requireOne);
  if (length === null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string") || keys.length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}

function stringArray(value: unknown, maximum: number, requireOne = false): string[] | null {
  const items = dataArray(value, maximum, requireOne);
  return items && items.every((item) => typeof item === "string") ? items as string[] : null;
}

function parsedRoleBindings(value: unknown): NormalizedRoleBindings | null {
  try {
    const roles = dataRecord(value, rawRoleKeys, ["protagonistId", "aliases"]);
    if (!roles || typeof roles.protagonistId !== "string" || (Object.hasOwn(roles, "version") && roles.version !== 1)) return null;

    const protagonistAliasCount = boundedArrayLength(roles.aliases, MAX_ROLE_ALIASES, true);
    const counterpartIdCount = Object.hasOwn(roles, "counterpartIds") ? boundedArrayLength(roles.counterpartIds, MAX_ROLE_ENTITIES) : 0;
    const opponentIdCount = Object.hasOwn(roles, "opponentIds") ? boundedArrayLength(roles.opponentIds, MAX_ROLE_ENTITIES) : 0;
    const counterpartCount = Object.hasOwn(roles, "counterparts") ? boundedArrayLength(roles.counterparts, MAX_ROLE_ENTITIES) : 0;
    const opponentCount = Object.hasOwn(roles, "opponents") ? boundedArrayLength(roles.opponents, MAX_ROLE_ENTITIES) : 0;
    if (protagonistAliasCount === null || counterpartIdCount === null || opponentIdCount === null || counterpartCount === null || opponentCount === null
      || counterpartCount + opponentCount > MAX_ROLE_ENTITIES) return null;

    const rawCounterparts = Object.hasOwn(roles, "counterparts") ? dataArray(roles.counterparts, MAX_ROLE_ENTITIES)! : [];
    const rawOpponents = Object.hasOwn(roles, "opponents") ? dataArray(roles.opponents, MAX_ROLE_ENTITIES)! : [];
    const entityKeys = new Set(["id", "aliases"]);
    const entityRecords: Array<{ id: string; aliases: unknown; aliasCount: number }> = [];
    let aliasCount = protagonistAliasCount;
    for (const entity of [...rawCounterparts, ...rawOpponents]) {
      const item = dataRecord(entity, entityKeys, ["id", "aliases"]);
      if (!item || Object.keys(item).length !== entityKeys.size || typeof item.id !== "string") return null;
      const itemAliasCount = boundedArrayLength(item.aliases, MAX_ALIASES_PER_ENTITY, true);
      if (itemAliasCount === null) return null;
      aliasCount += itemAliasCount;
      if (aliasCount > MAX_ROLE_ALIASES) return null;
      entityRecords.push({ id: item.id, aliases: item.aliases, aliasCount: itemAliasCount });
    }

    const aliases = stringArray(roles.aliases, MAX_ROLE_ALIASES, true);
    const counterpartIds = Object.hasOwn(roles, "counterpartIds") ? stringArray(roles.counterpartIds, MAX_ROLE_ENTITIES)! : [];
    const opponentIds = Object.hasOwn(roles, "opponentIds") ? stringArray(roles.opponentIds, MAX_ROLE_ENTITIES)! : [];
    if (!aliases || !counterpartIds || !opponentIds) return null;
    const entities = entityRecords.map((item) => {
      const entityAliases = stringArray(item.aliases, item.aliasCount, true);
      return entityAliases ? { id: item.id, aliases: entityAliases } : null;
    });
    if (entities.some((entity) => entity === null)) return null;
    const counterparts = entities.slice(0, counterpartCount) as Array<{ id: string; aliases: string[] }>;
    const opponents = entities.slice(counterpartCount) as Array<{ id: string; aliases: string[] }>;
    return { version: 1, protagonistId: roles.protagonistId, aliases, counterpartIds, opponentIds, counterparts, opponents };
  } catch {
    return null;
  }
}

export function canonicalRoleKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function validRawRoleBindings(value: unknown): value is ScheduleExperienceRequest["roleBindings"] {
  return parsedRoleBindings(value) !== null;
}

export function normalizeRoleBindings(value: ScheduleExperienceRequest["roleBindings"]): ExperienceStagePlan["roleBindings"] {
  const normalized = parsedRoleBindings(value);
  if (!normalized) throw new TypeError("invalid raw role bindings");
  return normalized;
}

export function validTrustedRoleBindings(value: unknown): value is ExperienceStagePlan["roleBindings"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const roles = value as Record<string, unknown>;
  const expectedKeys = ["aliases", "counterpartIds", "counterparts", "opponentIds", "opponents", "protagonistId", "version"].sort();
  const safeRoleValue = (input: unknown): input is string => typeof input === "string"
    && input.length <= MAX_ROLE_VALUE_LENGTH
    && !roleControlCharacter.test(input)
    && !!canonicalRoleKey(input);
  if (Object.keys(roles).sort().join("|") !== expectedKeys.join("|") || roles.version !== 1 || !safeRoleValue(roles.protagonistId)) return false;
  if (!Array.isArray(roles.aliases) || !Array.isArray(roles.counterpartIds) || !Array.isArray(roles.opponentIds) || !Array.isArray(roles.counterparts) || !Array.isArray(roles.opponents)) return false;
  if (roles.counterparts.length + roles.opponents.length > MAX_ROLE_ENTITIES) return false;

  const stringList = (input: unknown[], requireOne = false, maximum = MAX_ROLE_ALIASES): input is string[] => input.length <= maximum
    && (!requireOne || input.length > 0)
    && input.every(safeRoleValue);
  if (!stringList(roles.aliases, true) || !stringList(roles.counterpartIds, false, MAX_ROLE_ENTITIES) || !stringList(roles.opponentIds, false, MAX_ROLE_ENTITIES)) return false;

  const entitiesValid = (entities: unknown[], ids: string[]): entities is Array<{ id: string; aliases: string[] }> => {
    if (!entities.every((entity) => {
      if (!entity || typeof entity !== "object" || Array.isArray(entity) || Object.keys(entity).sort().join("|") !== "aliases|id") return false;
      const item = entity as Record<string, unknown>;
      return safeRoleValue(item.id) && Array.isArray(item.aliases) && stringList(item.aliases, true, MAX_ALIASES_PER_ENTITY);
    })) return false;
    const entityIds = entities.map((entity) => (entity as { id: string }).id).sort();
    const expectedIds = [...ids].sort();
    return expectedIds.length === entityIds.length
      && expectedIds.every((id, index) => id === entityIds[index]);
  };
  if (!entitiesValid(roles.counterparts, roles.counterpartIds) || !entitiesValid(roles.opponents, roles.opponentIds)) return false;

  const entities = [...roles.counterparts, ...roles.opponents];
  const allAliases = [...roles.aliases, ...entities.flatMap((item) => item.aliases)];
  if (allAliases.length > MAX_ROLE_ALIASES) return false;
  const roleValues = [roles.protagonistId, ...roles.counterpartIds, ...roles.opponentIds, ...allAliases];
  if (roleValues.reduce((total, item) => total + item.length, 0) > MAX_ROLE_CHARACTER_BUDGET) return false;
  const identityKeys = [roles.protagonistId, ...entities.map((item) => item.id)].map(canonicalRoleKey);
  if (new Set(identityKeys).size !== identityKeys.length) return false;
  const aliasKeys = allAliases.map(canonicalRoleKey);
  if (new Set(aliasKeys).size !== aliasKeys.length) return false;
  if (aliasKeys.some((alias) => identityKeys.includes(alias))) return false;
  return true;
}
