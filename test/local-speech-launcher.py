"""Launcher checks with isolated environment files and mocked native workers."""

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("local_speech", Path(__file__).resolve().parents[1] / "scripts/local-speech.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class SpeechLauncherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.root_patch = patch.object(launcher, "ROOT", self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.environment = patch.dict(os.environ, {"PATH": os.environ["PATH"]}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_node_env_file_parsing_and_shell_precedence(self):
        self.assertEqual(launcher.tts_provider(), "local")
        (self.root / ".env").write_text('TTS_PROVIDER="elevenlabs" # voice backend\nELEVENLABS_API_KEY="test-secret"\n')
        self.assertEqual(launcher.tts_provider(require_credentials=True), "elevenlabs")
        os.environ["ELEVENLABS_VOICE_ID"] = "   "
        self.assertEqual(launcher.tts_provider(require_credentials=True), "elevenlabs")
        os.environ["TTS_PROVIDER"] = "local"
        self.assertEqual(launcher.tts_provider(require_credentials=True), "local")

    def test_invalid_provider_and_missing_credentials_fail_before_workers(self):
        for values, expected in [
            ({"TTS_PROVIDER": "unknown"}, "TTS_PROVIDER"),
            ({"TTS_PROVIDER": "elevenlabs"}, "ELEVENLABS_API_KEY"),
            ({"TTS_PROVIDER": "elevenlabs", "ELEVENLABS_API_KEY": "   "}, "ELEVENLABS_API_KEY"),
        ]:
            with self.subTest(values=tuple(values)), patch.dict(os.environ, values), patch.object(launcher.subprocess, "Popen") as popen:
                # A configuration failure must occur before native processes start.
                with patch.object(launcher, "tts_provider", side_effect=SystemExit(expected)):
                    with self.assertRaisesRegex(SystemExit, expected):
                        launcher.start("nemotron")
                popen.assert_not_called()
            with patch.dict(os.environ, values):
                with self.assertRaisesRegex(SystemExit, expected):
                    launcher.tts_provider(require_credentials=True)

    def test_worker_selection_and_shutdown(self):
        for provider, count in [("local", 3), ("elevenlabs", 2)]:
            with self.subTest(provider=provider):
                children = [Mock() for _ in range(count)]
                for child in children:
                    child.wait.return_value = 0
                    child.poll.return_value = None
                with patch.object(launcher, "tts_provider", return_value=provider), patch.object(launcher.subprocess, "Popen", side_effect=children) as popen, patch("builtins.print"):
                    with self.assertRaisesRegex(SystemExit, "Speech server exited"):
                        launcher.start("qwen")
                self.assertEqual(popen.call_count, count)
                commands = [call.args[0] for call in popen.call_args_list]
                self.assertIn("qwen3_asr_server", commands[0][0])
                self.assertEqual(any("voxtral_tts_server" in command[0] for command in commands), provider == "local")
                self.assertEqual(commands[-1][0], "node")
                environment = popen.call_args_list[-1].kwargs["env"]
                self.assertEqual(environment["TTS_PROVIDER"], provider)
                self.assertEqual(environment["LOCAL_ASR_MODEL"], launcher.MODELS["qwen"][0])
                for child in children:
                    child.terminate.assert_called_once()


if __name__ == "__main__":
    unittest.main()
