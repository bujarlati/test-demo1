import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AppStore, AuditEvent, UserAccount, UserProfile } from "../src/types";

export interface AuthLocals {
  user: UserAccount;
}

export function publicUser(user: UserAccount): UserProfile {
  const { id, email, name, initials, role, activeStoryId, defaultConnectionId } = user;
  return { id, email, name, initials, role, activeStoryId, defaultConnectionId };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createAuditEvent(
  actorUserId: string,
  action: string,
  targetType: AuditEvent["targetType"],
  targetId: string,
  metadata: AuditEvent["metadata"] = {},
): AuditEvent {
  return {
    id: `audit_${randomUUID().slice(0, 10)}`,
    actorUserId,
    action,
    targetType,
    targetId,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

export function audit(
  store: AppStore,
  actorUserId: string,
  action: string,
  targetType: AuditEvent["targetType"],
  targetId: string,
  metadata: AuditEvent["metadata"] = {},
) {
  store.auditEvents.unshift(createAuditEvent(actorUserId, action, targetType, targetId, metadata));
  store.auditEvents = store.auditEvents.slice(0, 500);
}

export function verifyPassword(user: UserAccount, password: string): boolean {
  const attempted = scryptSync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === attempted.length && timingSafeEqual(expected, attempted);
}

export function createAuthSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  return {
    token,
    session: {
    id: `session_${randomUUID().slice(0, 10)}`,
    userId,
    tokenHash: hashSessionToken(token),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

export function createReaderAccount(email: string, password: string, name: string): UserAccount {
  const canonicalEmail = normalizeEmail(email);
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const passwordSalt = randomBytes(16).toString("hex");
  return {
    id: `user_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    email: canonicalEmail,
    passwordSalt,
    passwordHash: scryptSync(password, passwordSalt, 64).toString("hex"),
    name: normalizedName,
    initials: Array.from(normalizedName)[0]?.toUpperCase() ?? "读",
    role: "reader",
    activeStoryId: null,
    defaultConnectionId: "conn_platform",
  };
}

export function login(store: AppStore, email: string, password: string) {
  const user = store.users.find((item) => normalizeEmail(item.email) === normalizeEmail(email));
  if (!user || !verifyPassword(user, password)) return null;
  const { token, session } = createAuthSession(user.id);
  store.sessions = store.sessions.filter((item) => Date.parse(item.expiresAt) > Date.now());
  store.sessions.push(session);
  audit(store, user.id, "auth.login", "auth", user.id, { role: user.role });
  return { token, session, user: publicUser(user) };
}

export function authenticate(
  store: AppStore,
  resolveUser?: (tokenHash: string) => Promise<UserAccount | null>,
) {
  return async (
    request: Request,
    response: Response<unknown, AuthLocals>,
    next: NextFunction,
  ) => {
    const header = request.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const hash = token ? hashSessionToken(token) : "";
    try {
      const session = resolveUser ? undefined : store.sessions.find(
        (item) => item.tokenHash === hash && Date.parse(item.expiresAt) > Date.now(),
      );
      const user = resolveUser
        ? await resolveUser(hash)
        : session ? store.users.find((item) => item.id === session.userId) ?? null : null;
      if (!user) {
        response.status(401).json({ message: "请登录后继续。" });
        return;
      }
      response.locals.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAdmin(
  _request: Request,
  response: Response<unknown, AuthLocals>,
  next: NextFunction,
) {
  if (response.locals.user.role !== "admin") {
    response.status(403).json({ message: "此操作仅限平台管理员。" });
    return;
  }
  next();
}
