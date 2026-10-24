# Debate Practice Assistant Specification

Status: CLI and web debate practice implemented, including compiled speaker persona selection, plus a web Arena for model comparisons and provisional judging. Local SDK, HTTP API and CLI verification is recorded in the test suite; live provider compatibility requires configured credentials and endpoint verification.

Product intent: [intent.md](intent.md). Technology choices and provider configuration: [tech-stack.md](tech-stack.md).

## Goal

Help a human practice debating a topic against an assistant that maintains an opposing position. The first version supports an informal exchange; a complete competition format remains in the backlog.

## Source-to-persona workflow

The source library collects video references and supplied transcripts. After extracting and validating a named speaker's remarks, use the Codex SDK with the existing ChatGPT OAuth login to analyze all saved records matching that normalized speaker name. Save the result as `data/persona-<uuid>/persona.md`, with metadata in `persona.json`. This compilation creates reusable prompt context; it does not fine-tune a model.

The persona gives direct agent instructions for language and vocabulary preferences, sentence rhythm, tone and register, rhetorical devices, argument structure, evidence use, interaction and rebuttal habits, and treatment of uncertainty and values. Keep observations, source evidence, confidence, limitations and provenance in `persona.json` for tracing, separate from the instruction-only `persona.md`. Mark dimensions that the sources cannot establish in the analysis and use neutral practice behavior for them. Do not infer acoustic voice characteristics from transcripts or invent the speaker's views on unrelated topics.

The human can inspect and download the Markdown before practice. Adding sources does not silently change a persona: rebuild it, then start a new debate to use the new version. Previously saved personas require a rebuild to adopt the instruction-only format. Practice receives only the saved persona as speaker context.

## Core workflow

### 1. Submit a topic

The human enters a topic as free text. Reject empty input without calling the model. The human can replace the topic before choosing a side.

### 2. Establish two opposing positions

The assistant proposes one debate motion and exactly two positions: affirmative and negative. Both positions address the same motion and make clear, opposing claims that each side can defend.

Example:

- Topic: AI in education.
- Motion: Schools should allow students to use AI for homework.
- Affirmative: Schools should allow students to use AI for homework.
- Negative: Schools should not allow students to use AI for homework.

The human can accept the proposal or regenerate it before choosing a side. Position generation must not begin the debate or choose the human's side automatically.

### 3. Choose sides

The human selects affirmative or negative. The application assigns the other side to the assistant and displays both assignments. Side selection becomes fixed when the practice session starts; switching sides starts a new session.

### 4. Generate opening arguments

The assistant presents two or three distinct arguments supporting its assigned position. Each argument contains a claim and an explanation, with an example where useful. The assistant must distinguish hypothetical examples from factual evidence and must not invent citations or statistics.

### 5. Exchange arguments

The human submits a response, challenge, or question. The assistant responds to that contribution, uses the previous discussion as context, and continues defending its assigned position. It may concede a valid point without silently changing sides. It must not generate the human's next contribution.

Only one assistant turn may be active per session. Show when generation is in progress and retain the conversation if generation fails. Display a completed assistant response only after the turn succeeds.

### 6. End practice

The human can end the session at any time or start another topic. Ending does not require a winner, score, or formal closing round.

## Session behavior

The web app first selects a compiled speaker persona alongside the topic. The speaker selector lists the latest saved persona for each normalized speaker name. The source library remains available for adding and reviewing source records and rebuilding personas. The chosen persona Markdown is copied into the debate context so later source changes or persona rebuilds cannot alter an active debate.

The human also chooses a model from the configured provider's live model list, limited to DeepSeek V4.1 Flash 1017, MiniMax-M3.1-Flash, Nemotron-3.5-Lightning, Gemma-4-31B-it, Qwen3.8-27B, Muse Spark Open and GLM 5.3 Flash, in that order. Practice and Arena share this allowlist, including Arena participants and judges. Only exact model IDs returned by the provider are offered; see the [model ID table](../README.md#web-debate-practice). An available `NEBIUS_MODEL` within this selection is the default; otherwise the first available choice is selected. The server caches discovery for five minutes and validates the selection before creating an agent, including when an API request omits the model. No available allowed model means the request fails. The same model is used for all session actions and restored with the session snapshot. Choosing a model in the web app requires only the provider base URL and API key; it does not require `NEBIUS_MODEL`.

The opponent is explicitly labeled as a simulation. Its prompt includes the saved persona Markdown, with direct instructions on communication patterns and practice behavior. Observations, confidence, evidence, source provenance, raw source remarks, transcripts and summaries are excluded from practice context. The model must not present generated arguments as the real speaker's statements or fabricate their position on an unrelated topic. The assigned side is a practice role. The interface displays both assignments and identifies the compiled persona.

The web interface supports position regeneration, side selection, completed messages, failed-generation retries and ending during generation. Changing the topic or persona starts a new debate. Refreshing the page restores the current session by ID while the server still holds it. Sessions expire after one hour of inactivity; server restart clears them.

| State | Allowed actions | Successful transition |
| --- | --- | --- |
| Topic entry | Submit a topic | Positions ready |
| Positions ready | Regenerate positions, replace topic, choose a side | Positions ready or opening generation |
| Opening generation | Wait or end | Active practice |
| Active practice | Submit a contribution or end | Response generation or ended |
| Response generation | Wait or end | Active practice |
| Ended | Start a new session | Topic entry |

A generation error preserves the last confirmed topic, positions, assignments, and completed messages. It must offer a retry or a new session without duplicating the human's contribution. Ending during generation cancels the run where supported and prevents late output from reopening the session.

## Conversation requirements

- Preserve the motion and side assignments throughout the session.
- Keep different sessions isolated.
- Treat debate content as conversation input; it cannot change application configuration or grant tool access.
- Use clear, respectful language while challenging the human's reasoning.
- Support text input and output first. Repository documentation remains English; the practice language can follow the human's language.

## Arena

Arena is the third web tab, alongside Practice and Source library. It evaluates models using the existing Practice agent's preparation, opening, and reply methods, including its simulation rules and saved persona context. It must not introduce a separate argument-generation prompt that makes the comparison unlike actual practice.

The human selects a saved speaker persona, a topic and a judge model. The server randomly selects four distinct model IDs from the shared model allowlist, potentially across different configured providers; credentials remain on the server. The first participant prepares the shared motion and positions. The human reviews those positions and chooses one side for all four participants. Each participant receives the same saved persona Markdown and an empty conversation history; raw training sources are excluded.

The comparison contains four independent openings. Each opening is saved and scored before the next participant begins. Completed contributions and scores remain available if a later generation or evaluation fails. A retry resumes the unfinished step and continues the remaining participants; ending aborts work and suppresses late output. Provider and model selections are fixed for a session. Each model request has a five-minute timeout by default, configurable from 30 to 600 seconds through `ARENA_REQUEST_TIMEOUT_SECONDS`.

Scoring uses the same speech judge as Practice and runs automatically after every opening. The judge receives the topic, positions, chosen side and target speech, without model identities, persona instructions, other speeches or earlier scores. It returns validated clarity, reasoning and engagement scores from 0 to 100 with short comments; the overall score is their rounded mean. The UI displays each score as it becomes available and labels it provisional. Invalid or failed judge output must not produce fabricated scores. Scores assess these speeches and do not establish an overall model ranking.

Arena sessions are held in memory and expire after one hour of inactivity. A server restart clears them. The interface can restore an existing session after a page reload while it is still held by the server.

## Technical requirements

- Use Codex as the agent harness and the Codex SDK for programmatic interaction.
- Use Nebius as the initial model API provider for source extraction and practice.
- Use an existing Codex ChatGPT OAuth login for persona compilation, without falling back to the practice provider.
- Persist a reviewable Markdown persona and load that file for practice instead of original source material.
- Read the endpoint, API key, and model ID from environment variables.
- Support changing to another compatible custom endpoint through configuration alone.
- Keep credentials outside prompts, transcripts, committed files, and user-facing error messages.
- Validate the configured endpoint with the actual Codex SDK before declaring it supported. A generic OpenAI-compatible API label is insufficient.

The standalone [technology document](tech-stack.md) describes the implementation, configuration mapping, compatibility checks, and unresolved choices.

## Acceptance criteria

1. A topic produces one motion with exactly two opposing positions, rather than two questions.
2. The human can regenerate positions and choose either side; the assistant receives the opposite side.
3. The assistant generates opening arguments only after side selection.
4. The human and assistant can exchange multiple turns with stable side assignments and relevant context.
5. Empty input, repeated submissions, and failed generation do not corrupt the session or duplicate messages.
6. Ending a session prevents additional assistant messages from being committed to it.
7. A Nebius integration check completes position generation, an opening, and at least two follow-up turns through the Codex SDK.
8. Changing the configured base URL routes model requests to the new compatible endpoint without code changes or fallback to another provider.
9. Missing configuration and authentication or protocol errors produce useful messages without exposing secrets.
10. Source records compile into direct agent instructions in `persona.md`, with observations, evidence, confidence, limitations and source provenance retained separately in `persona.json`.
11. Web practice requires a compiled persona and passes its saved Markdown, without raw source records, to the opponent.
12. Multiple saved source records for the same normalized speaker name contribute to one compiled persona; rebuilding affects new sessions only.
13. Persona compilation requires Codex ChatGPT OAuth and does not fall back to Nebius or an API-key login.

## Backlog

- Structured competition sessions with defined rounds, speaking order, time limits, rebuttals, and closing statements.
- Final Arena judging criteria, repeatable evaluation across swapped sides, and coaching feedback.
- Voice interaction.
- Browsing archived debate sessions, subject to later product decisions.

These features are outside the first practice workflow.
