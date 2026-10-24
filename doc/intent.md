# Intent: Debate Practice Assistant

## Purpose

Build a debate assistant that helps a human practice discussing a topic, developing arguments, and responding to an opposing viewpoint.

Use the same argument-generation path in Arena to compare models and providers under the application's real practice instructions and source context. A separate judge evaluates the resulting exchange and the interface visualizes its scores. The final judging criteria are still to be defined; initial scores use an explicitly provisional prompt.

## Intended workflow

1. **Enter a topic.** The human provides a topic they want to debate.
2. **Establish opposing positions.** The assistant turns the topic into two clearly stated, opposing positions, like the affirmative and negative sides in a debate competition. Each position is a claim that its side will defend. For example, for the topic "AI in education," the positions could be "Schools should allow students to use AI for homework" and "Schools should not allow students to use AI for homework."
3. **Choose sides.** The human and assistant each take a side, with the assistant taking the side opposite the human.
4. **Generate arguments.** Once sides are chosen, the assistant generates arguments for its position to begin the discussion.
5. **Practice through interaction.** The human responds, challenges arguments, and asks questions. The assistant replies from its assigned side so the exchange can develop into a debate.

## Current scope

Implement the topic-to-practice workflow as a local web app and text CLI using the Codex SDK and a configurable Nebius endpoint. In the web app, the human chooses a ready speaker from saved source records, enters a topic, reviews positions and starts a multi-turn debate. The opponent is a labeled simulation informed by the speaker's documented remarks.

The web app has three tabs: Practice, Source library, and Arena. Arena compares an affirmative model and a negative model, optionally from different configured providers, using the same preparation, opening, and reply module as Practice. Both models receive the same saved speaker context and positions. Each generates an opening and a rebuttal, then a separately selected judge can score the completed exchange. Scores and rationale are labeled provisional until the evaluation criteria are finalized. A single match is a comparison under its assigned sides, not an overall model ranking. Complete competition sessions remain future work.

## Backlog

- [x] Implement topic input and generation of two opposing positions for the affirmative and negative sides.
- [x] Add side selection for the human and assistant.
- [x] Generate arguments for the assistant's selected side.
- [x] Support an interactive exchange of arguments, questions, and responses.
- [x] Add a web debate room with topic entry, ready-speaker selection and source-informed responses.
- [x] Add Arena to compare models and providers through the real Practice generation path, with a separate judge and provisional score visualization.
- Define the final judging criteria and replace the provisional judge prompt.
- **Future: form a structured debate.** Build on the practice workflow to support a complete debate session. Define the debate format, turn structure, and completion criteria when this feature is taken up.
