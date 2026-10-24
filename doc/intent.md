# Intent: Debate Practice Assistant

## Purpose

Build a debate assistant that helps a human practice discussing a topic, developing arguments, and responding to an opposing viewpoint.

## Intended workflow

1. **Enter a topic.** The human provides a topic they want to debate.
2. **Explore opposite viewpoints.** The assistant generates two questions about the topic, one from each of two opposing sides.
3. **Choose sides.** The human and assistant each take a side, with the assistant taking the side opposite the human.
4. **Generate arguments.** Once sides are chosen, the assistant generates arguments for its position to begin the discussion.
5. **Practice through interaction.** The human responds, challenges arguments, and asks questions. The assistant replies from its assigned side so the exchange can develop into a debate.

## Current scope

Initialize the repository and record the product intent. The workflow above describes the desired experience; implementation is future work.

## Backlog

- Implement topic input and generation of two questions representing opposing viewpoints.
- Add side selection for the human and assistant.
- Generate arguments for the assistant's selected side.
- Support an interactive exchange of arguments, questions, and responses.
- **Future: form a structured debate.** Build on the practice workflow to support a complete debate session. Define the debate format, turn structure, and completion criteria when this feature is taken up.
