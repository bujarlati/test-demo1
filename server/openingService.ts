import type {
  CreateStoryInput,
  EndingContract,
  ModelConnection,
  ReadingExperienceContract,
  Story,
  StoryGene,
  WorldBible,
} from "../src/types";
import { captureCanonState } from "./canonState";
import {
  assertImmersiveNarration,
  assertPersistentExperienceFacts,
  assertReadingExperienceEvidence,
  assertReadingExperienceNegativeInvariants,
  type GeneratedChapter,
} from "./narrativeEngine";
import { createStory } from "./storyService";
import { generateStoryOpeningWithConnection } from "./modelGateway";
import { safetyCategories } from "./safetyService";
import { normalizeChapterTitle } from "./narrationPolicy";
import {
  OPENING_CHAPTER_MAX_CHARACTERS,
  OPENING_CHAPTER_MIN_CHARACTERS,
  openingChapterCharacterCount,
  openingChapterLengthIsAllowed,
} from "./openingConstraints";

export interface OpeningGenerationContext {
  input: CreateStoryInput;
  contract: ReadingExperienceContract;
  targetChapterCount: number;
}

export interface GeneratedStoryOpening {
  title: string;
  subtitle: string;
  leadName: string;
  storyGene: Omit<StoryGene, "version" | "createdAt">;
  endingContract: Pick<EndingContract, "targetEnding" | "characterArc" | "prerequisites">;
  worldBible: Omit<WorldBible, "version" | "sourceRevisionIds">;
  readingExperience?: ReadingExperienceContract;
  chapter: GeneratedChapter;
  event: {
    title: string;
    cause: string;
    outcome: string;
    location: string;
    persistentFacts: string[];
  };
  plannerModel: string;
  writerModel: string;
  usageTokens: number;
  usageEstimated: boolean;
}

export type StoryOpeningGenerator = (
  context: OpeningGenerationContext,
  connection: ModelConnection,
) => Promise<GeneratedStoryOpening>;

export type StoryOpeningObserver = (generated: GeneratedStoryOpening) => void;
export type StoryOpeningPublicationGate = (story: Story) => void;

export function storyOpeningPublicationText(story: Story): string {
  const chapters = story.chapters.map((chapter) => {
    const revision = chapter.revisions.find((item) => item.id === chapter.currentRevisionId);
    return {
      title: chapter.title,
      revisionTitle: revision?.title,
      paragraphs: revision?.paragraphs ?? [],
    };
  });
  return JSON.stringify({
    title: story.title,
    subtitle: story.subtitle,
    summary: story.summary,
    latestExcerpt: story.latestExcerpt,
    readingExperience: story.readingExperience,
    storyGene: story.storyGene,
    endingContract: story.endingContract,
    worldBible: story.worldBible,
    summaries: story.summaries,
    events: story.events,
    chapters,
    characters: story.characters.map((character) => ({
      name: character.name,
      role: character.role,
      status: character.status,
      location: character.location,
      goal: character.goal,
      knowledge: character.knowledge,
      relationship: character.relationship,
    })),
    items: story.items,
    rules: story.rules,
    clues: story.clues,
  });
}

export function assertStoryOpeningPublicationSafe(story: Story): void {
  if (safetyCategories(storyOpeningPublicationText(story)).length === 0) return;
  const error = new Error("内容触发安全策略，未写入故事。你可以修改表达，或通过举报/申诉流程请求复核。");
  Object.assign(error, { status: 422 });
  throw error;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`开篇生成结果缺少${label}。`);
  return normalized;
}

function validateOpeningResult(
  baseContract: ReadingExperienceContract,
  connection: ModelConnection,
  generated: GeneratedStoryOpening,
): void {
  requiredText(generated.title, "书名");
  requiredText(generated.subtitle, "副标题");
  requiredText(generated.leadName, "主角名");
  requiredText(normalizeChapterTitle(generated.chapter.title), "第一章标题");
  if (generated.plannerModel !== connection.routes.planner || generated.writerModel !== connection.routes.writer) {
    throw new Error("开篇生成结果的模型路由与所选连接不一致，已拒绝发布。");
  }
  if (generated.chapter.model !== connection.routes.writer) {
    throw new Error("第一章没有由所选正文模型生成，已拒绝发布。");
  }
  if (generated.chapter.paragraphs.length < 12 || !generated.chapter.paragraphs.every((paragraph) => typeof paragraph === "string" && paragraph.trim())) {
    throw new Error("第一章段落不足或包含空段，已拒绝发布。");
  }
  const content = generated.chapter.paragraphs.join("\n");
  const characterCount = openingChapterCharacterCount(content);
  if (!openingChapterLengthIsAllowed(content)) {
    throw new Error(
      `第一章字数为 ${characterCount} 字，要求 ${OPENING_CHAPTER_MIN_CHARACTERS}—${OPENING_CHAPTER_MAX_CHARACTERS} 字，已拒绝发布。`,
    );
  }
  assertImmersiveNarration(normalizeChapterTitle(generated.chapter.title));
  assertImmersiveNarration(content);
  const contract = generated.readingExperience ?? baseContract;
  if (contract.sourceWords.join("\u0000") !== baseContract.sourceWords.join("\u0000")) {
    throw new Error("规划模型改变了用户输入的阅读体验词，已拒绝发布。");
  }
  assertReadingExperienceNegativeInvariants(contract, JSON.stringify({
    storyGene: generated.storyGene,
    endingContract: generated.endingContract,
    worldBible: generated.worldBible,
  }), { protagonistNames: [generated.leadName] });
  assertReadingExperienceEvidence(contract, content, generated.chapter.experienceEvidence, {
    protagonistNames: [generated.leadName],
    opening: true,
    chapterNumber: 1,
  });
  for (const value of [generated.event.title, generated.event.cause, generated.event.outcome, generated.event.location]) {
    if (Array.from(requiredText(value, "开篇事件")).length < 4) throw new Error("开篇事件信息过短，已拒绝发布。");
  }
  assertPersistentExperienceFacts(contract, content, generated.event.persistentFacts, {
    protagonistNames: [generated.leadName],
    chapterNumber: 1,
  });
}

export async function createStoryWithOpening(
  input: CreateStoryInput,
  ownerId: string,
  connection: ModelConnection,
  generateOpening: StoryOpeningGenerator = generateStoryOpeningWithConnection,
  observeOpening?: StoryOpeningObserver,
  publicationGate: StoryOpeningPublicationGate = assertStoryOpeningPublicationSafe,
): Promise<Story> {
  if (connection.status !== "active") throw new Error("所选模型连接尚未通过测试，无法生成故事。");
  const story = createStory(input, ownerId);
  const generated = await generateOpening({
    input,
    contract: story.readingExperience,
    targetChapterCount: story.targetChapterCount,
  }, connection);
  // Provider usage is incurred even when a later quality/publication gate rejects
  // the draft, so expose it before validation can throw.
  observeOpening?.(generated);
  validateOpeningResult(story.readingExperience, connection, generated);

  const createdAt = story.updatedAt;
  const chapter = story.chapters[0];
  const revision = chapter.revisions.find((item) => item.id === chapter.currentRevisionId)!;
  const lead = story.characters[0];
  const eventId = story.events[0].id;
  const contract = generated.readingExperience ?? story.readingExperience;

  story.title = generated.title.trim().slice(0, 80);
  story.subtitle = generated.subtitle.trim().slice(0, 180);
  story.readingExperience = contract;
  story.storyGene = { ...generated.storyGene, version: 1, createdAt };
  story.endingContract = {
    ...generated.endingContract,
    version: 1,
    status: "viable",
    lastEvaluatedAt: createdAt,
  };
  story.worldBible = {
    ...generated.worldBible,
    version: 1,
    sourceRevisionIds: [revision.id],
  };
  story.summary = `${story.subtitle}。${story.storyGene.conflictEngine}`;
  story.latestExcerpt = generated.chapter.paragraphs.at(-1) ?? generated.chapter.paragraphs[0];
  story.modelConnectionId = connection.id;

  chapter.title = normalizeChapterTitle(generated.chapter.title).slice(0, 120);
  chapter.estimatedMinutes = Math.max(10, Math.round(generated.chapter.paragraphs.join("").length / 260));
  revision.title = chapter.title;
  revision.paragraphs = generated.chapter.paragraphs.map((paragraph) => paragraph.trim());
  revision.reason = "规划模型建立阅读体验契约，正文模型生成并通过开篇质量门禁";
  revision.modelName = generated.writerModel;
  revision.promptVersion = "opening-v1";

  lead.name = generated.leadName.trim().slice(0, 80);
  lead.initials = Array.from(lead.name)[0] ?? "主";
  lead.location = generated.event.location.trim().slice(0, 120);
  lead.goal = story.storyGene.visibleGoal;
  lead.relationship = "";
  lead.knowledge = Array.from(new Set(
    generated.event.persistentFacts.map((fact) => fact.trim().slice(0, 180)),
  ));
  lead.knowledgeSources = lead.knowledge.map((fact) => ({ fact, sourceChapter: 1, sourceRevisionId: revision.id }));

  story.events = [{
    id: eventId,
    chapterNumber: 1,
    revisionId: revision.id,
    type: "consequence",
    title: generated.event.title.trim().slice(0, 180),
    cause: generated.event.cause.trim().slice(0, 240),
    outcome: generated.event.outcome.trim().slice(0, 280),
    participantIds: [lead.id],
    location: generated.event.location.trim().slice(0, 120),
    dependsOn: [],
    active: true,
    creativeAxis: story.storyGene.creativeAxes[0],
    sequence: 1,
    storyTime: "第1章",
    branchId: story.activeBranchId,
  }];

  // The local story factory only provides a temporary shape while the selected
  // models generate the opening. Do not let its invented props enter canon.
  story.items = [];
  story.rules = [];
  story.clues = [];

  story.summaries = story.summaries.map((summary) => ({
    ...summary,
    text: `${chapter.title}：${revision.paragraphs[0]} ${revision.paragraphs.at(-1) ?? ""}`.slice(0, summary.layer === "scene" ? 420 : 560),
    updatedAt: createdAt,
  }));
  story.conversation[0].content = "故事基因、阅读体验契约与第一章已经由所选模型生成并通过质量检查。";

  const state = captureCanonState(story);
  story.branches[0].baseStateSnapshot = structuredClone(state);
  story.branches[0].stateSnapshot = state;
  publicationGate(story);
  return story;
}
