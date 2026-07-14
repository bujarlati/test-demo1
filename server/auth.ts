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

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function audit(
  store: AppStore,
  actorUserId: string,
  action: string,
  targetType: AuditEvent["targetType"],
  targetId: string,
  metadata: AuditEvent["metadata"] = {},
) {
  store.auditEvents.unshift({
    id: `audit_${randomUUID().slice(0, 10)}`,
    actorUserId,
    action,
    targetType,
    targetId,
    createdAt: new Date().toISOString(),
    metadata,
  });
  store.auditEvents = store.auditEvents.slice(0, 500);
}

export function login(store: AppStore, email: string, password: string) {
  const user = store.users.find((item) => item.email.toLowerCase() === email.toLowerCase());
  if (!user) return null;
  const attempted = scryptSync(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  if (expected.length !== attempted.length || !timingSafeEqual(expected, attempted)) return null;
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
  store.sessions.push({
    id: `session_${randomUUID().slice(0, 10)}`,
    userId: user.id,
    tokenHash: tokenHash(token),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  audit(store, user.id, "auth.login", "auth", user.id, { role: user.role });
  return { token, user: publicUser(user) };
}

export function authenticate(store: AppStore) {
  return (
    request: Request,
    response: Response<unknown, AuthLocals>,
    next: NextFunction,
  ) => {
    const header = request.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const hash = token ? tokenHash(token) : "";
    const session = store.sessions.find(
      (item) => item.tokenHash === hash && Date.parse(item.expiresAt) > Date.now(),
    );
    const user = session ? store.users.find((item) => item.id === session.userId) : undefined;
    if (!user) {
      response.status(401).json({ message: "请登录后继续。" });
      return;
    }
    response.locals.user = user;
    next();
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
