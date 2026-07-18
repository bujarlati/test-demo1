import { assessExperience } from "./assessor";
import { compileExperience } from "./compiler";
import { scheduleExperience } from "./scheduler";
import type { ReadingExperienceModule, ReadingExperienceModuleDependencies } from "./types";

export function createReadingExperienceModule(deps: ReadingExperienceModuleDependencies): ReadingExperienceModule {
  const interpretation = deps.interpretationPort.interpret.bind(deps.interpretationPort);
  const judge = deps.semanticJudgePort.judge.bind(deps.semanticJudgePort);
  const state = Object.freeze({ read: deps.statePort.read.bind(deps.statePort), consumeTicket: deps.statePort.consumeTicket.bind(deps.statePort), consumePermit: deps.statePort.consumePermit.bind(deps.statePort), consumeRepair: deps.statePort.consumeRepair.bind(deps.statePort), ...(deps.statePort.bindArtifactDigest ? { bindArtifactDigest: deps.statePort.bindArtifactDigest.bind(deps.statePort) } : {}) });
  const config = Object.freeze({ ...deps, interpretationPort: Object.freeze({ interpret: interpretation }), semanticJudgePort: Object.freeze({ judge }), statePort: state, ticketSecret: `${deps.ticketSecret}`, now: deps.now.bind(deps) });
  const module: ReadingExperienceModule = {
    compile: (request) => compileExperience(request, config.interpretationPort, config.now),
    schedule: (request) => scheduleExperience(request, config),
    assess: (request) => assessExperience(request, config),
  };
  return Object.freeze(module);
}
