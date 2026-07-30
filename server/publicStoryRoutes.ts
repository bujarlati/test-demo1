import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { STORY_GENRES, type StoryGenre } from "../src/storyConfig";
import type { ContentReport, StoryPublicationStatus, UserAccount } from "../src/types";
import {
  PublicStorySharingError,
  type PublicStorySharingErrorCode,
  type PublicStorySharingModule,
} from "./publicStorySharing";

export interface PublicStoryReportInput {
  reporterUserId: string;
  storyId: string;
  chapterId: string;
  revisionId: string;
  reason: string;
}

export type PersistPublicStoryReport = (
  input: PublicStoryReportInput,
) => Promise<ContentReport>;

export type PublicStoryObservedRoute =
  | "publication.status"
  | "publication.publish"
  | "publication.unpublish"
  | "public_profile.update"
  | "public_story.list"
  | "public_story.detail"
  | "public_story.progress"
  | "public_story.report"
  | "publication.suspend"
  | "publication.restore";

export interface PublicStoryRequestObservation {
  routeName: PublicStoryObservedRoute;
  statusCode: number;
  latencyMs: number;
  requestCorrelationId: string;
}

export interface PublicStoryModerationAuditInput {
  actorUserId: string;
  storyId: string;
  action: "suspend" | "restore";
  resultingStatus: StoryPublicationStatus;
  reason?: string;
}

export interface PublicStoryRouterOptions {
  getSharingModule: () => PublicStorySharingModule;
  persistReport: PersistPublicStoryReport;
  observeRequest?: (observation: PublicStoryRequestObservation) => void;
  recordModerationAudit?: (input: PublicStoryModerationAuditInput) => Promise<void>;
}

interface PublicStoryRouteLocals {
  user?: UserAccount;
  publicStorySharing?: PublicStorySharingModule;
}

const storyGenreValues = STORY_GENRES.map((genre) => genre.label) as [StoryGenre, ...StoryGenre[]];
const storyIdParamsSchema = z.object({
  storyId: z.string().trim().min(1).max(200),
});
const publicStoryIdParamsSchema = z.object({
  publicStoryId: z.string().trim().min(1).max(200),
});
const publicationInputSchema = z.object({
  published: z.boolean(),
  publicPenName: z.string().max(100).optional(),
});
const publicProfileInputSchema = z.object({
  publicPenName: z.string().max(100),
});
const discoverQuerySchema = z.object({
  query: z.string().trim().max(100).optional(),
  genre: z.enum(storyGenreValues).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});
const publicProgressInputSchema = z.object({
  chapterId: z.string().trim().min(1).max(200),
  scrollProgress: z.number().finite().min(0).max(1),
  expectedVersion: z.number().int().min(0),
});
const publicReportInputSchema = z.object({
  chapterId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(300),
});
const invalidModerationReasonCharacter = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const suspendInputSchema = z.object({
  reason: z.string().trim().min(1).max(120).refine(
    (reason) => !invalidModerationReasonCharacter.test(reason),
  ),
});

const sharingErrorStatuses: Record<PublicStorySharingErrorCode, number> = {
  invalid_public_pen_name: 422,
  story_not_owned: 403,
  story_not_publishable: 409,
  publication_suspended: 409,
  public_story_unavailable: 404,
  progress_conflict: 409,
  invalid_public_story_cursor: 400,
  public_story_sharing_disabled: 404,
  public_story_sharing_requires_postgresql: 503,
};

function routeError(
  status: number,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Error & {
  status: number;
  code: string;
  details?: Readonly<Record<string, unknown>>;
} {
  return Object.assign(new Error(message), { status, code, details });
}

function currentUser(response: Response): UserAccount {
  const user = (response.locals as PublicStoryRouteLocals).user;
  if (!user) {
    throw routeError(401, "authentication_required", "请登录后继续。");
  }
  return user;
}

function currentAdmin(response: Response): UserAccount {
  const user = currentUser(response);
  if (user.role !== "admin") {
    throw routeError(403, "admin_required", "此操作仅限平台管理员。");
  }
  return user;
}

function sharingModule(
  response: Response,
  getSharingModule: () => PublicStorySharingModule,
): PublicStorySharingModule {
  const locals = response.locals as PublicStoryRouteLocals;
  if (!locals.publicStorySharing) {
    locals.publicStorySharing = getSharingModule();
  }
  return locals.publicStorySharing;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

function observedRouteName(request: Request): PublicStoryObservedRoute | null {
  const method = request.method.toUpperCase();
  const routePath = request.path;
  if (method === "GET" && /^\/stories\/[^/]+\/publication$/u.test(routePath)) {
    return "publication.status";
  }
  if (method === "PUT" && /^\/stories\/[^/]+\/publication$/u.test(routePath)) {
    return request.body?.published === true
      ? "publication.publish"
      : request.body?.published === false
        ? "publication.unpublish"
        : "publication.status";
  }
  if (method === "PATCH" && routePath === "/me/public-profile") return "public_profile.update";
  if (method === "GET" && routePath === "/public-stories") return "public_story.list";
  if (method === "GET" && /^\/public-stories\/[^/]+$/u.test(routePath)) return "public_story.detail";
  if (method === "PUT" && /^\/public-stories\/[^/]+\/progress$/u.test(routePath)) {
    return "public_story.progress";
  }
  if (method === "POST" && /^\/public-stories\/[^/]+\/reports$/u.test(routePath)) {
    return "public_story.report";
  }
  if (method === "POST" && /^\/ops\/publications\/[^/]+\/suspend$/u.test(routePath)) {
    return "publication.suspend";
  }
  if (method === "POST" && /^\/ops\/publications\/[^/]+\/restore$/u.test(routePath)) {
    return "publication.restore";
  }
  return null;
}

function codedErrorFields(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
} {
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      code: "invalid_request",
      message: "提交内容不完整或格式不正确。",
      details: { issues: error.issues },
    };
  }
  if (error instanceof PublicStorySharingError) {
    return {
      status: sharingErrorStatuses[error.code],
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof Error) {
    const status = "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    const code = "code" in error && typeof error.code === "string"
      ? error.code
      : status >= 500 ? "internal_error" : "request_failed";
    const details = "details" in error
      && typeof error.details === "object"
      && error.details !== null
      && !Array.isArray(error.details)
      ? error.details as Readonly<Record<string, unknown>>
      : undefined;
    return {
      status,
      code,
      message: status >= 500 ? "服务器处理失败。" : error.message,
      ...(details === undefined ? {} : { details }),
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "服务器处理失败。",
  };
}

export function createPublicStoryRouter(options: PublicStoryRouterOptions): Router {
  const router = Router();

  router.use((request, response, next) => {
    const routeName = observedRouteName(request);
    if (!routeName || !options.observeRequest) {
      next();
      return;
    }
    const startedAt = Date.now();
    const requestCorrelationId = randomUUID();
    response.once("finish", () => {
      try {
        options.observeRequest?.({
          routeName,
          statusCode: response.statusCode,
          latencyMs: Math.max(0, Date.now() - startedAt),
          requestCorrelationId,
        });
      } catch {
        // Telemetry must never change the outcome of the observed request.
      }
    });
    next();
  });

  router.use((_request, response, next) => {
    response.set("Cache-Control", "private, no-store");
    next();
  });

  router.get("/stories/:storyId/publication", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { storyId } = storyIdParamsSchema.parse(request.params);
    response.json(await sharingModule(response, options.getSharingModule).getOwnerPublication(user.id, storyId));
  }));

  router.put("/stories/:storyId/publication", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { storyId } = storyIdParamsSchema.parse(request.params);
    const input = publicationInputSchema.parse(request.body);
    response.json(await sharingModule(response, options.getSharingModule).setOwnerPublication(user, storyId, input));
  }));

  router.patch("/me/public-profile", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const input = publicProfileInputSchema.parse(request.body);
    response.json(await sharingModule(response, options.getSharingModule).updatePublicProfile(user.id, input));
  }));

  router.get("/public-stories", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const query = discoverQuerySchema.parse(request.query);
    response.json(await sharingModule(response, options.getSharingModule).discover(user.id, query));
  }));

  router.get("/public-stories/:publicStoryId", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { publicStoryId } = publicStoryIdParamsSchema.parse(request.params);
    response.json(await sharingModule(response, options.getSharingModule).read(user.id, publicStoryId));
  }));

  router.put("/public-stories/:publicStoryId/progress", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { publicStoryId } = publicStoryIdParamsSchema.parse(request.params);
    const input = publicProgressInputSchema.parse(request.body);
    response.json(await sharingModule(response, options.getSharingModule).saveProgress(user.id, publicStoryId, input));
  }));

  router.post("/public-stories/:publicStoryId/reports", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { publicStoryId } = publicStoryIdParamsSchema.parse(request.params);
    const input = publicReportInputSchema.parse(request.body);
    const target = await sharingModule(response, options.getSharingModule).validateReportTarget(
      user.id,
      publicStoryId,
      input.chapterId,
    );
    const report = await options.persistReport({
      reporterUserId: user.id,
      storyId: target.storyId,
      chapterId: target.chapterId,
      revisionId: target.revisionId,
      reason: input.reason,
    });
    response.status(201).json(report);
  }));

  router.post("/ops/publications/:publicStoryId/suspend", asyncRoute(async (request, response) => {
    const user = currentAdmin(response);
    const { publicStoryId } = publicStoryIdParamsSchema.parse(request.params);
    const { reason } = suspendInputSchema.parse(request.body);
    const result = await sharingModule(response, options.getSharingModule).moderate(user.id, publicStoryId, {
      action: "suspend",
      reason,
    });
    await options.recordModerationAudit?.({
      actorUserId: user.id,
      storyId: publicStoryId,
      action: "suspend",
      reason: result.adminReason ?? reason,
      resultingStatus: result.status,
    });
    response.json(result);
  }));

  router.post("/ops/publications/:publicStoryId/restore", asyncRoute(async (request, response) => {
    const user = currentAdmin(response);
    const { publicStoryId } = publicStoryIdParamsSchema.parse(request.params);
    const result = await sharingModule(response, options.getSharingModule).moderate(user.id, publicStoryId, {
      action: "restore",
    });
    await options.recordModerationAudit?.({
      actorUserId: user.id,
      storyId: publicStoryId,
      action: "restore",
      resultingStatus: result.status,
    });
    response.json(result);
  }));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const failure = codedErrorFields(error);
    if (failure.status >= 500) {
      console.error(`[public-story-api] ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    response.status(failure.status).json({
      message: failure.message,
      code: failure.code,
      ...(failure.details === undefined ? {} : { details: failure.details }),
    });
  });

  return router;
}
