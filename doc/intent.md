# Intent: Debate Practice Assistant

## Purpose

Build a debate assistant that helps a human practice discussing a topic, developing arguments, and responding to an opposing viewpoint.

Use the same argument-generation path in Arena to compare models and providers under the application's real practice instructions and saved persona context. A separate judge evaluates each opening speech and the interface visualizes its scores. The final judging criteria are still to be defined; initial scores use an explicitly provisional prompt.

## Intended workflow

1. **Build a speaker persona.** Add and review source transcripts, then use the Codex SDK with ChatGPT OAuth to analyze how the speaker communicates. Save direct agent instructions in a Markdown persona covering vocabulary, register, sentence patterns, rhetoric, reasoning, rebuttal habits and uncertainty. Retain observations, confidence, evidence, limitations and source provenance separately in `persona.json` for tracing.
2. **Enter a topic.** The human provides a topic they want to debate.
3. **Establish opposing positions.** The assistant turns the topic into two clearly stated, opposing positions, like the affirmative and negative sides in a debate competition. Each position is a claim that its side will defend. For example, for the topic "AI in education," the positions could be "Schools should allow students to use AI for homework" and "Schools should not allow students to use AI for homework."
4. **Choose sides.** The human and assistant each take a side, with the assistant taking the side opposite the human.
5. **Generate arguments.** Once sides are chosen, the assistant generates arguments for its position to begin the discussion.
6. **Practice through interaction.** The human responds, challenges arguments, and asks questions. The assistant replies from its assigned side so the exchange can develop into a debate.

## Current scope

Implement the topic-to-practice workflow as a local web app and text CLI using the Codex SDK and a configurable Nebius endpoint. In the web app, the source library trains a reusable speaker persona by analyzing saved source records through the Codex SDK with ChatGPT OAuth. The human reviews the generated Markdown, chooses that compiled persona, enters a topic, reviews positions and starts a multi-turn debate. Practice reads only the persona as speaker context. The opponent is a labeled simulation that applies the speaker's observed communication patterns to its assigned side; it does not represent new arguments as the person's actual views. Persona compilation supplies prompt instructions and does not fine-tune model weights. Structured competition sessions remain future work.

The web app has three tabs: Practice, Source library, and Arena. Arena compares four models, optionally from different configured providers, through independent opening speeches for the same chosen side and saved persona. A separately selected judge scores each opening using the shared provisional speech criteria. See the [Arena specification](spec.md#arena) for selection, generation and scoring behavior. Complete competition sessions remain future work.

## Backlog

- [x] Implement topic input and generation of two opposing positions for the affirmative and negative sides.
- [x] Add side selection for the human and assistant.
- [x] Generate arguments for the assistant's selected side.
- [x] Support an interactive exchange of arguments, questions, and responses.
- [x] Add a web debate room with topic entry, compiled-persona selection and persona-guided responses.
- [x] Compile source material into a speaker persona Markdown using Codex OAuth and load that persona in practice.
- [x] Add Arena to compare models and providers through the real Practice generation path, with a separate judge and provisional score visualization.
- Define the final judging criteria and replace the provisional judge prompt.
- **Future: form a structured debate.** Build on the practice workflow to support a complete debate session. Define the debate format, turn structure, and completion criteria when this feature is taken up.
