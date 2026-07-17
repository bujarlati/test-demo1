import { assessExperience } from "./assessor";
import { compileExperience } from "./compiler";
import { scheduleExperience } from "./scheduler";
import type { ReadingExperienceModule, ReadingExperienceModuleDependencies } from "./types";

export function createReadingExperienceModule(deps: ReadingExperienceModuleDependencies): ReadingExperienceModule {
  const module: ReadingExperienceModule = {
    compile: (request) => compileExperience(request, deps.interpretationPort, deps.now),
    schedule: (request) => scheduleExperience(request, deps),
    assess: (request) => assessExperience(request, deps),
  };
  return Object.freeze(module);
}
