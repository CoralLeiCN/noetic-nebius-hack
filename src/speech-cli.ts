import { readFile, stat, writeFile } from "node:fs/promises";
import { SpeechServiceClient, MAX_AUDIO_BYTES } from "./speech.js";

const [command, input, output] = process.argv.slice(2);
const controller = new AbortController();
for (const event of ["SIGINT", "SIGTERM"] as const) process.once(event, () => controller.abort(new Error("Speech canceled.")));
try {
  const speech = new SpeechServiceClient();
  if (command === "transcribe" && input && !output) {
    if ((await stat(input)).size > MAX_AUDIO_BYTES) throw new Error("Audio must be at most 16 MiB.");
    console.log((await speech.transcribe(await readFile(input), controller.signal)).text);
  } else if (command === "speak" && input && output) {
    await writeFile(output, await speech.speak(input, controller.signal), { flag: "wx" });
    console.log(`Speech saved to ${output}`);
  } else {
    console.log('Usage: npm run speech -- transcribe <audio-file>\n       npm run speech -- speak "Text to speak" <new-output.wav>');
    if (command && !["--help", "-h"].includes(command)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local speech failed.");
  process.exitCode = 1;
}
