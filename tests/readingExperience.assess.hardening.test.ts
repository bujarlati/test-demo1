import assert from "node:assert/strict";
import test from "node:test";
import { assessExperience, verifyPublicationPermit, verifyRepairToken } from "../server/readingExperienceModule/assessor";
import type { AssessmentStatePort } from "../server/readingExperienceModule/types";

test("assessment state, permit and repair protocols are explicit public seams", async () => {
  const state: AssessmentStatePort = {
    read: async () => ({ activationId: "a", branchId: "b", canonVersion: 1, ledgerRevision: 1, attempt: 1, consumedTicketIds: [], consumedPermitIds: [], consumedRepairIds: [] }),
    consumeTicket: async () => true,
    consumePermit: async () => true,
    consumeRepair: async () => true,
  };
  assert.equal(typeof state.read, "function");
  assert.equal(typeof verifyPublicationPermit, "function");
  assert.equal(typeof verifyRepairToken, "function");
  assert.equal(typeof assessExperience, "function");
});
