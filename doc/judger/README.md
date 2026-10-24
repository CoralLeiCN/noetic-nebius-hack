# Debate judging

Edit the runtime judging prompt in [`src/prompts/argument-judge.ts`](../../src/prompts/argument-judge.ts) for speeches in Practice, the CLI and Arena. It contains the shared system instructions, provisional criteria and evaluation task. [`src/prompts/arena-judge.ts`](../../src/prompts/arena-judge.ts) is the legacy whole-exchange prompt and is not used by the current Arena flow. The [prompt index](../../src/prompts/README.md) lists every application prompt and explains how to apply edits.

## Practice speech feedback

Practice automatically judges each generated opening and reply, and each submitted human contribution, using a separate judge runtime with the selected practice model and provider. Spoken contributions are judged from the reviewed, submitted speech-to-text text, just like typed arguments. Drafts and raw recordings are not judged. The CLI uses the same speech judge.

Each speech receives a score from 0 to 100 and one concise comment. The collapsed card shows only that score and comment; **Score breakdown** expands the individual results for clarity, reasoning, and engagement, each with a score and a short explanation. These three provisional criteria have equal weight: the server calculates the overall score by rounding their arithmetic mean. The provisional label and criteria explanation appear inside the expanded details. The judge evaluates text only: it does not assess accent, pace, voice, or audio quality, and does not penalize filler words, repetitions, or disfluency alone. The six-speech competition rubric below remains a design draft, not the scoring contract for open practice.

The judge receives the topic, positions, target speech and preceding speeches identified only by side. It does not receive human/AI labels, model identities, persona instructions, earlier scores, or later speeches. Opening speeches are assessed without requiring answers to an opponent who has not spoken. All supplied content is untrusted debate data, and the judge must not invent supporting evidence.

Speech text is committed before evaluation. Judging failures leave the transcript intact and show an error on the affected speech; the next practice turn remains available. **Retry judging** retries only that speech's evaluation. The CLI equivalent is `/judge <turn>`, using the one-based turn number printed with feedback. The API accepts `POST /api/debates/:id/judge` with `{ "messageIndex": "0" }`, using a zero-based message index. Successful evaluations cannot be retried. Ending the debate aborts evaluation and ignores late results.

The server reports `generating_judgment` while evaluating speeches. Accepted message evaluations contain `judgment` with `score`, `rationale`, `breakdown`, `criteria`, and `provisional: true`; failures contain a sanitized `judgmentError`. The `breakdown` object requires `clarity`, `reasoning`, and `engagement`, each containing a numeric `score` from 0 to 100 and a nonempty `comment` of at most 240 characters. The overall `rationale` is limited to 180 characters, with the prompt requesting one sentence of at most 20 words. Missing or invalid criterion results fail evaluation instead of receiving invented scores. Older evaluations without a breakdown show their original explanation when expanded and explicitly state that detailed scores are unavailable.

Generated speech and human speech from one completed exchange are evaluated concurrently, and each evaluation sees only its own preceding context. Feedback is excluded from subsequent argument-generation prompts. Evaluation uses additional provider requests, each subject to the existing two-minute timeout.

## Arena speech comparison

Arena randomly selects four distinct model IDs from its configured providers and generates four independent opening speeches for one chosen side of the same motion. A model ID available from several providers counts as one candidate. At least four distinct IDs must be available before a session can be created. The candidates receive the same topic, positions, saved persona Markdown and empty conversation history. Openings use the canonical [parliamentary speaking-style prompt](../../src/prompts/parliamentary-speaking-style.md) through the same practice adapter as Practice.

### Shared scoring criteria

Arena automatically scores each opening immediately after it is generated, before the next participant begins, using Practice’s existing `CodexArgumentJudge` with the same structured response contract and validation. Each completed score is visible while the remaining participants run. A separate judge runtime uses the selected judge model, defaulting to the catalog default when none is selected. Every candidate is assessed by that same judge model. Scores for clarity, reasoning and engagement have equal weight; the application rounds their mean to calculate the overall score. Each result includes concise feedback and the criterion breakdown described above.

All scores are provisional and evaluate the supplied speeches on their shared topic and side. They do not establish an overall model ranking. Edit the shared speech judge prompt and update this document and validation tests together when changing the criteria.

### Input, recovery and cancellation

Each evaluation receives only the topic, shared motion and positions, chosen side and target speech. Its preceding-speeches list is empty. The judge does not receive model identities, persona instructions, other candidates’ speeches or earlier scores. Opening speeches are assessed for reasoning and anticipation of objections without requiring responses to opponents who have not spoken. Supplied content remains untrusted debate data; the judge must not invent evidence or treat simulated speeches as the real speaker’s statements.

Generated speech text is retained before evaluation. Failed generation or malformed judge output leaves confirmed speeches and successful scores intact. Retrying continues only the unfinished work, including remaining participants after a scoring retry; the application never substitutes sample or random scores. Arena preparation, opening and judge requests each default to a five-minute timeout, configurable with `ARENA_REQUEST_TIMEOUT_SECONDS` (30–600 seconds). Ending the session aborts in-progress work and prevents late output from being committed. Credentials and raw provider errors are excluded from public session data.

## Draft rubric

- [Scoring rubric](scoring-rubric.md): proposed dimensions, level descriptors, violations, speaker points, decision procedure and output format for structured 1v1 human–AI debates adapted from British Parliamentary rules. This six-speech format is a design draft for future structured sessions; current Arena opening comparisons use the same provisional speech criteria as Practice.
