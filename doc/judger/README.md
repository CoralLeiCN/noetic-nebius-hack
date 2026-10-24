# Debate judging

Edit the runtime judging prompts in [`src/prompts/argument-judge.ts`](../../src/prompts/argument-judge.ts) for individual speeches and [`src/prompts/arena-judge.ts`](../../src/prompts/arena-judge.ts) for Arena exchanges. Each file contains its system instructions, provisional criteria and evaluation task. The [prompt index](../../src/prompts/README.md) lists every application prompt and explains how to apply edits.

## Practice speech feedback

Practice automatically judges each generated opening and reply, and each submitted human contribution, using a separate judge runtime with the selected practice model and provider. Spoken contributions are judged from the reviewed, submitted speech-to-text text, just like typed arguments. Drafts and raw recordings are not judged. The CLI uses the same speech judge.

Each speech receives a score from 0 to 100 and one concise comment. The collapsed card shows only that score and comment; **Score breakdown** expands the individual results for clarity, reasoning, and engagement, each with a score and a short explanation. These three provisional criteria have equal weight: the server calculates the overall score by rounding their arithmetic mean. The provisional label and criteria explanation appear inside the expanded details. The judge evaluates text only: it does not assess accent, pace, voice, or audio quality, and does not penalize filler words, repetitions, or disfluency alone. The six-speech competition rubric below remains a design draft, not the scoring contract for open practice.

The judge receives the topic, positions, target speech and preceding speeches identified only by side. It does not receive human/AI labels, model identities, persona instructions, earlier scores, or later speeches. Opening speeches are assessed without requiring answers to an opponent who has not spoken. All supplied content is untrusted debate data, and the judge must not invent supporting evidence.

Speech text is committed before evaluation. Judging failures leave the transcript intact and show an error on the affected speech; the next practice turn remains available. **Retry judging** retries only that speech's evaluation. The CLI equivalent is `/judge <turn>`, using the one-based turn number printed with feedback. The API accepts `POST /api/debates/:id/judge` with `{ "messageIndex": "0" }`, using a zero-based message index. Successful evaluations cannot be retried. Ending the debate aborts evaluation and ignores late results.

The server reports `generating_judgment` while evaluating speeches. Accepted message evaluations contain `judgment` with `score`, `rationale`, `breakdown`, `criteria`, and `provisional: true`; failures contain a sanitized `judgmentError`. The `breakdown` object requires `clarity`, `reasoning`, and `engagement`, each containing a numeric `score` from 0 to 100 and a nonempty `comment` of at most 240 characters. The overall `rationale` is limited to 180 characters, with the prompt requesting one sentence of at most 20 words. Missing or invalid criterion results fail evaluation instead of receiving invented scores. Older evaluations without a breakdown show their original explanation when expanded and explicitly state that detailed scores are unavailable.

Generated speech and human speech from one completed exchange are evaluated concurrently, and each evaluation sees only its own preceding context. Feedback is excluded from subsequent argument-generation prompts. Evaluation uses additional provider requests, each subject to the existing two-minute timeout.

## Arena exchange feedback

Arena uses a separate judge model after both participants have completed their arguments. The judge runs through the same isolated Codex SDK adapter as the rest of the application, with judge-specific instructions and a structured response contract. Its provider and model are selected independently from the affirmative and negative participants.

### Provisional criteria

The final judging criteria are not ready. The current judge prompt uses clarity of claims, reasoning, and response to opposing arguments as a provisional rubric, with an explicit TODO to replace it with agreed criteria. It also asks the judge to check whether source claims respect the supplied evidence and uncertainty. The UI labels every resulting evaluation provisional. A score compares the arguments in this exchange under the assigned sides and speaking order; it is not an overall model ranking.

When final criteria are agreed, replace the placeholder in the judge prompt and update this document together with the validation tests. Keep the argument-generation path shared with Practice so the evaluation continues to reflect real usage.

Participant openings and rebuttals use the canonical [parliamentary speaking-style prompt](../../src/prompts/parliamentary-speaking-style.md) through the shared backend practice adapter. The judge uses its own instructions and does not receive this speaking-style text block.

### Input and output

The judge receives the topic, shared motion and positions, bounded speaker source context, and confirmed transcript. Model identities are omitted from the judge input to reduce provider preference. Participant arguments and source material are data, not instructions to change the judging task. The judge must assess the supplied exchange without inventing evidence or treating simulated arguments as the real speaker's statements.

The application validates the model's structured output before accepting it. Each side receives a numeric score from 0 to 100 and the evaluation includes a nonempty rationale. Accepted results carry the provisional criteria label. Failed generation or malformed output leaves the transcript intact and offers a retry; no placeholder or random scores are displayed.

Arena judging is available only after the exchange is complete. Ending the session aborts in-progress work and prevents late judge output from being committed. Credentials and raw provider errors are excluded from public session data.

## Draft rubric

- [Scoring rubric](scoring-rubric.md): proposed dimensions, level descriptors, violations, speaker points, decision procedure and output format for structured 1v1 human–AI debates adapted from British Parliamentary rules. This six-speech format is a design draft for future structured sessions; the current four-contribution Arena exchange continues to use the provisional criteria above.
