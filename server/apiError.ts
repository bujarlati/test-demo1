import type { ErrorRequestHandler } from "express";
import { z } from "zod";

export const apiErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      message: "提交内容不完整或格式不正确。",
      issues: error.issues,
    });
    return;
  }

  const status = error instanceof Error
    && "status" in error
    && typeof error.status === "number"
    ? error.status
    : 500;
  const message = error instanceof Error ? error.message : "服务器处理失败。";
  console.error(`[api] ${message}`);
  const code = error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
  const safetyDecisionId = error instanceof Error
    && "safetyDecisionId" in error
    && typeof error.safetyDecisionId === "string"
    ? error.safetyDecisionId
    : undefined;

  response.status(status).json({
    message,
    ...(code ? { code } : {}),
    ...(safetyDecisionId ? { safetyDecisionId } : {}),
  });
};
