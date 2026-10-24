# Debate Practice Assistant Specification

Status: Initial CLI implemented. Local SDK and CLI verification is recorded in the test suite; live Nebius compatibility requires running `npm run check:provider` with configured credentials.

Product intent: [intent.md](intent.md). Technology choices and provider configuration: [tech-stack.md](tech-stack.md).

## Goal

Help a human practice debating a topic against an assistant that maintains an opposing position. The first version supports an informal exchange; a complete competition format remains in the backlog.

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

## Technical requirements

- Use Codex as the agent harness and the Codex SDK for programmatic interaction.
- Use Nebius as the initial model API provider.
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

## Backlog

- Structured competition sessions with defined rounds, speaking order, time limits, rebuttals, and closing statements.
- Judging, scoring, and coaching feedback.
- Voice interaction.
- A richer graphical interface and browsing previous sessions, subject to later product decisions.

These features are outside the first practice workflow.
