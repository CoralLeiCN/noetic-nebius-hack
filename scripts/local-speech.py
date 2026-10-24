"""Build, run and measure SGLang-Omni's native MLX speech servers."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".speech"
SOURCE = STATE / "sglang-omni"
REVISION = "6e75cba89c598b41bcadf8d6a761c09e9979ad20"
MODELS = {
    "nemotron": ("mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit", "nemotron_asr_server", "nemotron_transcribe", "model_pins.json"),
    "qwen": ("mlx-community/Qwen3-ASR-1.7B-6bit", "qwen3_asr_server", "qwen3_asr_transcribe", "models.json"),
    "voxtral": ("mlx-community/Voxtral-4B-TTS-2603-mlx-4bit", "voxtral_tts_server", "voxtral_tts_synthesize", "model_pins.json"),
}


def model_directory(name):
    return STATE / "models" / MODELS[name][0].replace("/", "_")


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def setup(asr, compare):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Native MLX requires an Apple Silicon Mac.")
    for executable in ("git", "uv", "ffmpeg", "xcodebuild"):
        if not shutil.which(executable):
            raise SystemExit(f"Install {executable} before running speech:setup.")
    STATE.mkdir(exist_ok=True)
    if not SOURCE.exists():
        subprocess.run(["git", "init", str(SOURCE)], check=True)
        subprocess.run(["git", "-C", str(SOURCE), "remote", "add", "origin", "https://github.com/sgl-project/sglang-omni.git"], check=True)
        subprocess.run(["git", "-C", str(SOURCE), "fetch", "--depth", "1", "origin", REVISION], check=True)
        subprocess.run(["git", "-C", str(SOURCE), "checkout", "--detach", REVISION], check=True)
    actual = subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise SystemExit(f"Expected SGLang-Omni {REVISION}; found {actual}. Move the existing .speech/sglang-omni checkout before setup.")
    environment = dict(os.environ, UV_CACHE_DIR=str(STATE / "uv-cache"), UV_PYTHON_INSTALL_DIR=str(STATE / "python"), CMAKE_BUILD_PARALLEL_LEVEL="4")
    stamp = STATE / "runtime/revision.txt"
    binaries = [STATE / "runtime/bin" / entry[1] for entry in MODELS.values()]
    if not stamp.exists() or stamp.read_text().strip() != REVISION or not all(path.exists() for path in binaries):
        subprocess.run([str(SOURCE / "sglang_omni_mlx/native/scripts/build_runtime.sh"), str(STATE / "runtime")], env=environment, check=True)
        stamp.write_text(REVISION + "\n")
    selected = [asr, "voxtral"] + (["qwen" if asr == "nemotron" else "nemotron"] if compare else [])
    for name in selected:
        repository, _, _, pin_file = MODELS[name]
        pins = json.loads((SOURCE / "sglang_omni_mlx/native/ci" / pin_file).read_text())[repository]
        for filename, expected in pins["files"].items():
            destination = model_directory(name) / filename
            if destination.exists() and digest(destination) == expected:
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            partial = destination.with_suffix(destination.suffix + ".partial")
            url = f"https://huggingface.co/{repository}/resolve/{pins['revision']}/{filename}"
            print(f"Downloading {repository}/{filename}", flush=True)
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if digest(partial) != expected:
                partial.unlink()
                raise SystemExit(f"Checksum mismatch: {filename}")
            partial.replace(destination)
    print("Native MLX runtime and checked model weights are ready.")


def start(asr):
    children = []
    try:
        for name, port in ((asr, 8765), ("voxtral", 8766)):
            repository, binary, _, _ = MODELS[name]
            command = [str(STATE / "runtime/bin" / binary), "--model-path", str(model_directory(name)), "--model-name", repository, "--host", "127.0.0.1", "--port", str(port)]
            if name == "voxtral":
                command += ["--max-queued-requests", "1", "--request-timeout-s", "120"]
            children.append(subprocess.Popen(command))
        environment = dict(os.environ, LOCAL_ASR_MODEL=MODELS[asr][0], LOCAL_ASR_URL="http://127.0.0.1:8765", LOCAL_TTS_MODEL=MODELS["voxtral"][0], LOCAL_TTS_URL="http://127.0.0.1:8766")
        children.append(subprocess.Popen(["node", "--env-file-if-exists=.env", "dist/src/speech-server.js"], cwd=ROOT, env=environment))
        print("Speech microservice: http://127.0.0.1:8764 by default; workers on 8765 and 8766. Ctrl+C stops all three processes.", flush=True)
        while True:
            for child in children:
                try:
                    code = child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    continue
                raise SystemExit(f"Speech server exited ({code}).")
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def benchmark(asr, audio):
    STATE.mkdir(exist_ok=True)
    wav = STATE / "benchmark-input.wav"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(audio.resolve()), "-t", "120", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], check=True)
    with wave.open(str(wav), "rb") as reader:
        audio_seconds = reader.getnframes() / reader.getframerate()
    report = {"device": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(), "memory_bytes": int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True)), "sglang_revision": REVISION, "input_audio_seconds": audio_seconds, "measurements": []}
    for name in [asr, "voxtral"]:
        repository, _, binary, _ = MODELS[name]
        command = [str(STATE / "runtime/bin" / binary), "--model-path", str(model_directory(name))]
        if name == "voxtral":
            command += ["--text", "A strong argument needs clear evidence. We should consider the benefits, the costs, and the alternatives before reaching a conclusion.", "--voice", "neutral_female", "--seed", "42", "--max-new-tokens", "500", "--output", str(STATE / "benchmark-speech.wav")]
        else:
            command += [str(wav), str(wav), str(wav)]
        result = subprocess.run(["/usr/bin/time", "-l", *command], check=True, capture_output=True, text=True)
        lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        for line in lines:
            if name != "voxtral":
                line["real_time_factor"] = line["seconds"] / audio_seconds
        memory = re.search(r"(\d+)\s+maximum resident set size", result.stderr)
        footprint = re.search(r"(\d+)\s+peak memory footprint", result.stderr)
        report["measurements"].append({"model": repository, "peak_resident_bytes": int(memory.group(1)) if memory else None, "peak_footprint_bytes": int(footprint.group(1)) if footprint else None, "process_notes": result.stderr.strip(), "runs": lines})
    destination = STATE / f"benchmark-{asr}.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Saved {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start", "benchmark"))
    parser.add_argument("--asr", choices=("nemotron", "qwen"), default="nemotron")
    parser.add_argument("--compare", action="store_true", help="Download both ASR candidates for comparison.")
    parser.add_argument("--audio", type=Path, help="Representative speech recording for the benchmark (first 120 seconds).")
    arguments = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    if arguments.command == "setup":
        setup(arguments.asr, arguments.compare)
    elif arguments.command == "start":
        start(arguments.asr)
    elif arguments.audio:
        benchmark(arguments.asr, arguments.audio)
    else:
        parser.error("benchmark requires --audio <recording>")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
