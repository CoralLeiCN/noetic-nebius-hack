import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpeakingStyle } from "../src/speaking-style.js";

test("speaking style uses the complete canonical text block independently of working directory", async () => {
  const markdown = await readFile(new URL("../../doc/judger/parliamentary-speaking-style-prompt.md", import.meta.url), "utf8");
  const canonical = markdown.split("```text\n")[1]!.split("\n```")[0]!.trim();
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "debate-style-test-"));
  try {
    process.chdir(directory);
    const prompt = await loadSpeakingStyle();
    assert.equal(prompt, canonical.replaceAll("{SOURCE_EXCERPTS}", "None supplied. Use the style guidance above; do not invent or retrieve source excerpts."));
    assert.doesNotMatch(prompt, /\{SOURCE_EXCERPTS\}|```/);
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});
