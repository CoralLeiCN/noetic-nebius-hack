import { readFile } from "node:fs/promises";
import { DebateError } from "./errors.js";
import { NO_SOURCE_EXCERPTS } from "./prompts/debate.js";

/** Read the canonical prompt from either src/ or the compiled dist/src/. */
export async function loadSpeakingStyle(): Promise<string> {
  for (const relative of ["./prompts/parliamentary-speaking-style.md", "../../src/prompts/parliamentary-speaking-style.md"]) {
    let markdown: string;
    try { markdown = await readFile(new URL(relative, import.meta.url), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const prompt = /^```text\r?\n([\s\S]*?)\r?\n```\s*$/m.exec(markdown)?.[1]?.trim();
    if (!prompt || !prompt.includes("{SOURCE_EXCERPTS}")) {
      throw new DebateError("The parliamentary speaking-style prompt is invalid. Restore its text block and source-excerpts placeholder.");
    }
    return prompt.replaceAll("{SOURCE_EXCERPTS}", NO_SOURCE_EXCERPTS);
  }
  throw new DebateError("The parliamentary speaking-style prompt is missing. Restore src/prompts/parliamentary-speaking-style.md.");
}
