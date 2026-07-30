import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the personal library exposes publication controls without nesting them inside story links", async () => {
  const source = await readFile(new URL("../src/pages/LibraryPage.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ StoryPublicationActions \} from "\.\.\/components\/StoryPublicationActions";/);
  assert.ok(
    source.includes('<StoryPublicationActions story={activeStory} mode="library" />'),
    "the active story needs a visible library publication trigger",
  );

  const otherStoriesStart = source.indexOf("{otherStories.map((story) => (");
  const otherStoriesEnd = source.indexOf("))}", otherStoriesStart);
  assert.notEqual(otherStoriesStart, -1, "the other-stories block must exist");
  assert.notEqual(otherStoriesEnd, -1, "the other-stories block must be bounded");

  const otherStoriesBlock = source.slice(otherStoriesStart, otherStoriesEnd);
  const linkEnd = otherStoriesBlock.indexOf("</Link>");
  const publicationTrigger = otherStoriesBlock.indexOf(
    '<StoryPublicationActions story={story} mode="library" />',
  );
  assert.match(otherStoriesBlock, /<article\b/);
  assert.notEqual(linkEnd, -1, "each story card needs a navigation link");
  assert.ok(
    publicationTrigger > linkEnd,
    "the publication button must be a sibling after the story link, never an interactive child of it",
  );
});
