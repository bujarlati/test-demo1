# Volume transition TDD evidence

## Source and user journeys

The requirements were confirmed in the Codex task rather than supplied as a separate plan file.

- As an author-reader, I see stable canonical volume boundaries instead of fabricated parts that move as chapters are added.
- As a public-library reader, I see the same canonical volume and transition sections as the author.
- As an author, I get three purposeful bridge chapters at the end of every non-final volume: aftermath, relationship/resource/location handoff, and the doorway into the next volume.
- As a continuing reader, the next volume starts from concrete prior canon outcomes instead of an unexplained time, place, or conflict jump.
- Existing stories are not renumbered, and the behavior remains planning/writing guidance rather than a new publication gate.

## RED and GREEN report

| Task | Validation | Evidence | Guarantee |
|---|---|---|---|
| Introduce one shared story-structure contract | `.\node_modules\.bin\tsx.cmd --test tests\storyStructure.test.ts` | Initial RED: `ERR_MODULE_NOT_FOUND` for `src/storyStructure`; GREEN after implementation | The missing structure behavior was exercised before production code existed. |
| Pin and bound boundary continuity | Same targeted command | Review RED: the new-volume test omitted the last transition event and exceeded the bounded/untrusted-data contract; GREEN: all 7 tests passed | The prior chapter ending and its events cannot be displaced by later retcon records, and the extra context stays at or below 6,000 characters. |
| Avoid non-boundary scope expansion | Same targeted command | Review RED: ordinary planner prompts exposed newly added event cause/outcome fields; GREEN: ordinary prompts retain the original compact event references | Detailed continuity data is sent only for transition chapters and later-volume openings. |
| Enforce the model trust boundary | Same targeted command | Security-review RED: Planner/Writer system prompts did not define the tagged-data trust boundary; GREEN: both system prompts reject execution and verbatim replay | Story text inside the bounded JSON remains data even when it contains command-like prose, without adding a publication gate. |
| Carry the canonical target into public reading | `tsx --test --test-name-pattern="public repository lists and reads" tests\publicStorySharing.database.test.ts` | RED: `undefined !== 200`; GREEN: passed | Public readers receive `targetChapterCount`, allowing the public directory to use the same stable boundaries. |
| Preserve related behavior | Targeted narrative/structure suite plus public projection tests | 142 narrative/structure tests passed; public projection test passed | Continuation, ending, safety, budget, public projection, routing, and reading progress remain green. |
| Whole-project regression | `npm test` | 282/282 tests passed; exit code 0 | The complete configured test suite passed with the new structure tests included. |
| Static and production verification | `npm run typecheck`; `npm run build` | Both exited 0; Vite built 1,815 modules | Server, database projection, and both React readers share compatible types; the production bundle builds. |
| Keep server prompts out of the client | Inspect the generated Vite bundle | The transition label is present, while the internal guidance sentence is absent | Browsers receive directory structure only; Planner/Writer instructions remain server-side. |

## Coverage and known gaps

`tsx --test --experimental-test-coverage tests\storyStructure.test.ts` reported:

- `src/storyStructure.ts`: lines 98.26%, branches 84.62%, functions 100%.
- `server/storyArc.ts`: lines 81.10%, branches 85.00%, functions 100%.
- `server/storyEventSelectors.ts`: lines 100%, branches 100%, functions 100%.

The repository has no component-test harness for the reader pages, so directory behavior is tested through the pure shared section builder, the public database projection, TypeScript, and the production build. No migration is needed because existing chapter numbers and `targetChapterCount` already contain all required data.

Checkpoint commits were intentionally deferred because the governing feature-change workflow requires a human pre-commit gate. RED/GREEN evidence is preserved here before any later squash or commit.
