import type { Story, StoryEvent } from "../src/types";

export function activeBranchStoryEvents(story: Story): StoryEvent[] {
  return story.events.filter((event) => event.active && event.branchId === story.activeBranchId);
}
