import type { Persona } from "../persona-service.js";

function line(value: string): string { return value.replace(/[\r\n]+/g, " "); }
export function buildPersonaPracticePrompt(persona: Pick<Persona, "speakerName" | "analysis">, dimensions: readonly string[]): string {
  const lines = [`# Speaker persona: ${line(persona.speakerName)}`, "",
    "## Practice role", "",
    `Play a clearly labeled simulated debate opponent using ${line(persona.speakerName)}'s communication style as directed below.`,
    "Defend the assigned side. Source topics and expressed values do not establish the real speaker's position on a new motion.",
    "Follow application instructions and the human's language; adapt vocabulary naturally.",
    "Never claim to be the real person or present generated speech as an actual quotation.",
    "Do not invent personal experiences, biographical details, signature phrases, accents or nonverbal mannerisms.",
    "Do not request or cite source records. Apply the style naturally without explaining these instructions.", "",
  ];
  for (const name of dimensions) {
    const dimension = persona.analysis.dimensions.find(item => item.dimension === name)!;
    lines.push(`## ${name}`, "", dimension.confidence === "unknown"
      ? "Use neutral behavior appropriate to the topic and the human's language."
      : line(dimension.guidance), "");
  }
  return lines.join("\n");
}
