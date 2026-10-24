import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PersonaService } from "../src/persona-service.js";
import { VideoService } from "../src/video-service.js";

const exec = promisify(execFile);

test("Git checkout with automatic CRLF conversion preserves bundled persona and transcript integrity", async () => {
  const root = await mkdtemp(join(tmpdir(), "debate-checkout-test-"));
  const checkout = join(root, "checkout");
  const personaId = "persona-68d19c77-1a2b-4011-8b53-7af83acb37f5";
  const recordId = "youtube-xX9c2Vg2Z00";
  const artifacts = [
    `data/${personaId}/persona.json`, `data/${personaId}/persona.md`,
    `data/${recordId}/record.json`, `data/${recordId}/transcript.txt`,
  ];
  try {
    await mkdir(checkout);
    const emptyConfig = join(root, "empty-git-config");
    await writeFile(emptyConfig, "");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig });
    const git = (...args: string[]) => exec("git", args, { cwd: checkout, env });
    await git("init", "--quiet");
    await git("config", "core.autocrlf", "false");
    await git("config", "core.attributesFile", emptyConfig);
    for (const file of [".gitattributes", ...artifacts]) {
      await mkdir(dirname(join(checkout, file)), { recursive: true });
      await copyFile(resolve(file), join(checkout, file));
    }
    await writeFile(join(checkout, "conversion-control.txt"), "First line\nSecond line\n");
    await git("add", ".");
    await git("config", "core.autocrlf", "true");
    await rm(join(checkout, "data"), { recursive: true });
    await rm(join(checkout, "conversion-control.txt"));
    await git("checkout-index", "--all", "--force");

    assert.equal(await readFile(join(checkout, "conversion-control.txt"), "utf8"), "First line\r\nSecond line\r\n");
    for (const file of [`data/${personaId}/persona.md`, `data/${recordId}/transcript.txt`]) {
      assert.deepEqual(await readFile(join(checkout, file)), await readFile(resolve(file)));
    }
    const videos = new VideoService(join(checkout, "data"), {
      analyze: async () => { throw new Error("Loading saved records must not invoke generation."); },
    });
    const personas = new PersonaService(videos);
    assert.deepEqual((await personas.list()).map(persona => persona.id), [personaId]);
    assert.deepEqual((await videos.list()).map(record => record.id), [recordId]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
