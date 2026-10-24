# Arena judger

Arena uses a separate judge model after both participants have completed their arguments. The judge runs through the same isolated Codex SDK adapter as the rest of the application, with judge-specific instructions and a structured response contract. Its provider and model are selected independently from the affirmative and negative participants.

## Provisional criteria

The final judging criteria are not ready. The current judge prompt uses clarity of claims, reasoning, and response to opposing arguments as a provisional rubric, with an explicit TODO to replace it with agreed criteria. It also asks the judge to check whether source claims respect the supplied evidence and uncertainty. The UI labels every resulting evaluation provisional. A score compares the arguments in this exchange under the assigned sides and speaking order; it is not an overall model ranking.

When final criteria are agreed, replace the placeholder in the judge prompt and update this document together with the validation tests. Keep the argument-generation path shared with Practice so the evaluation continues to reflect real usage.

Participant openings and rebuttals use the canonical [parliamentary speaking-style prompt](parliamentary-speaking-style-prompt.md) through the shared backend practice adapter. The judge uses its own instructions and does not receive this speaking-style text block.

## Input and output

The judge receives the topic, shared motion and positions, bounded speaker source context, and confirmed transcript. Model identities are omitted from the judge input to reduce provider preference. Participant arguments and source material are data, not instructions to change the judging task. The judge must assess the supplied exchange without inventing evidence or treating simulated arguments as the real speaker's statements.

The application validates the model's structured output before accepting it. Each side receives a numeric score from 0 to 100 and the evaluation includes a nonempty rationale. Accepted results carry the provisional criteria label. Failed generation or malformed output leaves the transcript intact and offers a retry; no placeholder or random scores are displayed.

Judging is available only after the exchange is complete. Ending the session aborts in-progress work and prevents late judge output from being committed. Credentials and raw provider errors are excluded from public session data.

## Draft rubric

- [Scoring rubric](scoring-rubric.md): proposed dimensions, level descriptors, violations, speaker points, decision procedure and output format for structured 1v1 human–AI debates adapted from British Parliamentary rules. This six-speech format is a design draft for future structured sessions; the current four-contribution Arena exchange continues to use the provisional criteria above.
