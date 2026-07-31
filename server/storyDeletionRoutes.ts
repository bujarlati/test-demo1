import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { UserAccount } from "../src/types";
import {
  storyDeletionBusyError,
  storyNotFoundError,
  type PersistStoryDeletionInput,
} from "./storyDeletion";

type DeleteStoryCommand = Pick<
  PersistStoryDeletionInput,
  "ownerId" | "storyId" | "confirmationTitle"
>;

export type StoryMutationLease = () => void;

export type StoryMutationLockAttempt =
  | { acquired: true; release: StoryMutationLease }
  | { acquired: false; ownerId: string };

export interface StoryMutationLockManager {
  has(storyId: string): boolean;
  tryAcquire(storyId: string, ownerId: string): StoryMutationLockAttempt;
}

export function createStoryMutationLockManager(): StoryMutationLockManager {
  const leases = new Map<string, { ownerId: string; token: symbol }>();
  return {
    has: (storyId) => leases.has(storyId),
    tryAcquire: (storyId, ownerId) => {
      const current = leases.get(storyId);
      if (current) return { acquired: false, ownerId: current.ownerId };
      const token = Symbol(storyId);
      leases.set(storyId, { ownerId, token });
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          if (leases.get(storyId)?.token === token) leases.delete(storyId);
        },
      };
    },
  };
}

export interface StoryDeletionRouterOptions {
  storyMutationLocks: StoryMutationLockManager;
  deleteStory(input: DeleteStoryCommand): Promise<void>;
  ownsStory(ownerId: string, storyId: string): Promise<boolean>;
}

const paramsSchema = z.object({
  storyId: z.string().trim().min(1).max(200),
}).strict();
const bodySchema = z.object({
  confirmationTitle: z.string().trim().min(1).max(200),
}).strict();

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function currentUser(response: Response): UserAccount {
  const user = (response.locals as { user?: UserAccount }).user;
  if (!user) {
    throw Object.assign(new Error("请登录后继续。"), {
      status: 401,
      code: "authentication_required",
    });
  }
  return user;
}

export function createStoryDeletionRouter(options: StoryDeletionRouterOptions): Router {
  const router = Router();
  router.delete("/stories/:storyId", asyncRoute(async (request, response) => {
    const user = currentUser(response);
    const { storyId } = paramsSchema.parse(request.params);
    const { confirmationTitle } = bodySchema.parse(request.body);
    const lock = options.storyMutationLocks.tryAcquire(storyId, user.id);
    if (!lock.acquired) {
      if (lock.ownerId === user.id) throw storyDeletionBusyError();
      // A different user can hold only a short, unverified lease. Preserve ownership
      // privacy while that request performs its own probe under the lease.
      if (!await options.ownsStory(user.id, storyId)) throw storyNotFoundError();
      throw storyDeletionBusyError();
    }
    try {
      // Verify before invoking storage so a non-owner cannot use an unverified lease
      // to make the real owner observe a false not-found response.
      if (!await options.ownsStory(user.id, storyId)) throw storyNotFoundError();
      await options.deleteStory({ ownerId: user.id, storyId, confirmationTitle });
      response.status(204).end();
    } finally {
      lock.release();
    }
  }));
  return router;
}
