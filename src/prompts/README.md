# Runtime prompts

This directory is the source of truth for the application's authored model instructions and task templates. Edit prompts here; the service and SDK adapters import them rather than maintaining separate copies.

| File | Controls | Used by |
| --- | --- | --- |
| [debate.ts](debate.ts) | Debate system instructions, motion preparation and repair, openings, replies, speech names and word budgets | Web Practice, CLI and Arena participants through `CodexDebateAgent` |
| [parliamentary-speaking-style.md](parliamentary-speaking-style.md) | Canonical parliamentary speaking-style text block | Openings and replies through `loadSpeakingStyle` |
| [argument-judge.ts](argument-judge.ts) | Per-speech judge instructions, provisional criteria and evaluation task | Generated and human speeches in web Practice and the CLI; independent Arena openings |
| [video-analysis.ts](video-analysis.ts) | Source-transcript extraction instructions and task | Source library record creation |
| [persona-generation.ts](persona-generation.ts) | Evidence-based persona compilation instructions and task | Persona compilation through Codex OAuth |
| [persona-practice.ts](persona-practice.ts) | Compiled persona Markdown template, practice-role instructions and fallback guidance | Saved `persona.md` files supplied to debate practice |

## Editing and applying changes

The TypeScript files keep system instructions and task builders together for each workflow. Builders insert runtime data such as topics, positions and transcripts using JSON serialization. Keep this data separate from the instructions and preserve the existing untrusted-input boundaries.

After changing a TypeScript prompt, rebuild and restart the application (`npm run start:web` or `npm start` does both), then start a new session. After changing the speaking-style Markdown, restart and start a new session; each practice agent retains the version it loaded. Changing persona compilation or the persona Markdown template also requires rebuilding the saved persona before starting a new debate with it. Existing saved personas are not rewritten automatically.

Run `npm run typecheck` and `npm test` after edits. Output schemas, validation, provider settings, cancellation and retries remain in the service and SDK adapters. Changes to requested JSON fields must be coordinated with those schemas and validators.

## Related material

- [Judging behavior and API](../../doc/judger/README.md) explains speech judging in Practice and Arena.
- [Scoring rubric draft](../../doc/judger/scoring-rubric.md) is a proposal for structured six-speech sessions. It is not loaded by the runtime speech judge; Practice and Arena use the shared provisional criteria in this directory.
- Saved speaker personas under `data/persona-*/persona.md` are speaker-specific prompt context. Compiled personas retain their source metadata; authored personas, including Socrates, retain an explicit authored manifest and their supplied template. Keep both kinds under `data/` rather than copying them into this directory. See the [persona index](../../data/README.md).
- Speech transcription language and text-to-speech voices are service configuration, documented in [local speech](../../doc/local-speech.md), rather than LLM instruction templates.
