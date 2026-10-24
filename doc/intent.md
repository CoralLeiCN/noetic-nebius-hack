# Intent: Debate Practice Assistant

## Purpose

Build a debate assistant that helps a human practice discussing a topic, developing arguments, and responding to an opposing viewpoint.

## Intended workflow

1. **Enter a topic.** The human provides a topic they want to debate.
2. **Establish opposing positions.** The assistant turns the topic into two clearly stated, opposing positions, like the affirmative and negative sides in a debate competition. Each position is a claim that its side will defend. For example, for the topic "AI in education," the positions could be "Schools should allow students to use AI for homework" and "Schools should not allow students to use AI for homework."
3. **Choose sides.** The human and assistant each take a side, with the assistant taking the side opposite the human.
4. **Generate arguments.** Once sides are chosen, the assistant generates arguments for its position to begin the discussion.
5. **Practice through interaction.** The human responds, challenges arguments, and asks questions. The assistant replies from its assigned side so the exchange can develop into a debate.

## Current scope

Implement the topic-to-practice workflow as a local web app and text CLI using the Codex SDK and a configurable Nebius endpoint. In the web app, the human chooses a ready speaker from saved source records, enters a topic, reviews positions and starts a multi-turn debate. The opponent is a labeled simulation informed by the speaker's documented remarks. Structured competition sessions remain future work.

## Backlog

- [x] Implement topic input and generation of two opposing positions for the affirmative and negative sides.
- [x] Add side selection for the human and assistant.
- [x] Generate arguments for the assistant's selected side.
- [x] Support an interactive exchange of arguments, questions, and responses.
- [x] Add a web debate room with topic entry, ready-speaker selection and source-informed responses.
- **Future: form a structured debate.** Build on the practice workflow to support a complete debate session. Define the debate format, turn structure, and completion criteria when this feature is taken up.
