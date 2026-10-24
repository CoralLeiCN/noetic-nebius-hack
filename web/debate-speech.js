const MAX_RECORDING_MS = 115_000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 125_000;

export function splitSpeechText(text, limit = 300) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Speech chunk size must be a positive integer.");
  const chunks = [];
  let remaining = String(text).trim();
  while (remaining) {
    let end = Math.min(limit, remaining.length);
    if (remaining.length > limit) {
      const prefix = remaining.slice(0, limit + 1);
      const sentences = [...prefix.matchAll(/[.!?]["'”’)]*\s+/gu)];
      const words = [...prefix.matchAll(/\s+/gu)];
      const boundary = sentences.at(-1) || words.at(-1);
      if (boundary && boundary.index > 0 && boundary.index < limit) end = boundary.index + (sentences.length ? boundary[0].trimEnd().length : 0);
      if (end > limit) end = limit;
      if (end > 1 && /[\uD800-\uDBFF]/u.test(remaining[end - 1]) && /[\uDC00-\uDFFF]/u.test(remaining[end])) end--;
    }
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

export function createDebateSpeech(options = {}) {
  const environment = options.environment || globalThis;
  const Recorder = environment.MediaRecorder;
  const Controller = environment.AbortController || globalThis.AbortController;
  const BlobType = environment.Blob || globalThis.Blob;
  const setTimer = (environment.setTimeout || globalThis.setTimeout).bind(environment);
  const clearTimer = (environment.clearTimeout || globalThis.clearTimeout).bind(environment);
  const now = () => (environment.Date || Date).now();
  const supported = Boolean(environment.navigator?.mediaDevices?.getUserMedia && Recorder);
  let captureVersion = 0;
  let playbackVersion = 0;
  let recorder = null;
  let stream = null;
  let recordingTimer = null;
  let transcriptionTimer = null;
  let playbackTimer = null;
  let inputTimer = null;
  let inputContext = null;
  let inputSource = null;
  let inputAnalyser = null;
  let removeTrackListeners = null;
  let captureStartedAt = 0;
  let measuredInputSamples = 0;
  let maximumInputRms = 0;
  let captureHadMutedTrack = false;
  let transcriptionController = null;
  let playbackController = null;
  let audio = null;
  let audioUrl = null;
  let resumeAudio = null;
  let captureStatus = "";
  let playbackStatus = "";
  const state = { recording: false, capturing: false, transcribing: false, speaking: false, needsPlaybackGesture: false, supported,
    inputLevel: null, inputMonitoring: false, microphoneLabel: "", microphoneMuted: false, captureElapsedSeconds: 0, inputSignalDetected: false };
  const snapshot = () => ({ ...state, status: captureStatus || playbackStatus });
  const notify = () => options.onState?.(snapshot());
  const failure = message => options.onError?.(message);

  function releaseInputMonitor() {
    clearTimer(inputTimer);
    inputTimer = null;
    removeTrackListeners?.();
    removeTrackListeners = null;
    try { inputSource?.disconnect(); } catch { /* Monitoring must not block capture cleanup. */ }
    try { inputAnalyser?.disconnect(); } catch { /* A disconnected analyser is already released. */ }
    const context = inputContext;
    inputContext = null; inputSource = null; inputAnalyser = null;
    try { void context?.close()?.catch(() => {}); } catch { /* Audio monitoring is optional. */ }
    state.inputLevel = null;
    state.inputMonitoring = false;
    state.microphoneMuted = false;
  }
  function releaseMicrophone() {
    clearTimer(recordingTimer);
    recordingTimer = null;
    releaseInputMonitor();
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }
  function monitorMicrophone(acquired, version) {
    const track = acquired.getAudioTracks?.()[0] || acquired.getTracks()[0];
    state.microphoneLabel = track?.label || "Default microphone";
    const updateMuted = () => {
      if (version !== captureVersion || stream !== acquired) return;
      state.microphoneMuted = Boolean(track?.muted || track?.enabled === false || track?.readyState === "ended");
      captureHadMutedTrack ||= state.microphoneMuted;
      captureStatus = state.microphoneMuted
        ? "The microphone is muted or unavailable. Check your microphone input."
        : "Recording your argument… Stop when you are ready. Recording ends automatically before two minutes.";
      notify();
    };
    const ended = () => {
      if (version !== captureVersion || stream !== acquired) return;
      captureHadMutedTrack = true;
      state.microphoneMuted = true;
      failure("The microphone disconnected. Check your microphone input before recording again.");
      stopRecording();
    };
    if (track?.addEventListener) {
      track.addEventListener("mute", updateMuted);
      track.addEventListener("unmute", updateMuted);
      track.addEventListener("ended", ended);
      removeTrackListeners = () => {
        track.removeEventListener("mute", updateMuted);
        track.removeEventListener("unmute", updateMuted);
        track.removeEventListener("ended", ended);
      };
    }
    updateMuted();
    try {
      const Context = environment.AudioContext || environment.webkitAudioContext;
      if (Context) {
        inputContext = new Context();
        inputSource = inputContext.createMediaStreamSource(acquired);
        inputAnalyser = inputContext.createAnalyser();
        inputAnalyser.fftSize = 1024;
        inputSource.connect(inputAnalyser);
        if (inputContext.state === "suspended") void inputContext.resume()?.catch(() => {});
      }
    } catch {
      try { inputSource?.disconnect(); } catch { /* Recording still works without a meter. */ }
      try { inputAnalyser?.disconnect(); } catch { /* Each resource is released independently. */ }
      try { void inputContext?.close()?.catch(() => {}); } catch { /* Monitoring is optional. */ }
      inputContext = null; inputSource = null; inputAnalyser = null;
    }
    const samples = new Float32Array(1024);
    const measure = () => {
      if (version !== captureVersion || stream !== acquired || !state.recording) return;
      state.captureElapsedSeconds = Math.max(0, Math.floor((now() - captureStartedAt) / 1000));
      if (inputAnalyser && inputContext?.state === "running") {
        try {
          inputAnalyser.getFloatTimeDomainData(samples);
          let squared = 0;
          for (const sample of samples) squared += sample * sample;
          const rms = Math.min(1, Math.sqrt(squared / samples.length));
          state.inputLevel = rms;
          state.inputMonitoring = true;
          measuredInputSamples++;
          maximumInputRms = Math.max(maximumInputRms, rms);
          state.inputSignalDetected ||= rms >= 0.003;
        } catch { state.inputLevel = null; state.inputMonitoring = false; }
      } else { state.inputLevel = null; state.inputMonitoring = false; }
      notify();
      inputTimer = setTimer(measure, 100);
    };
    measure();
  }
  function releaseAudio() {
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load?.();
    }
    if (audioUrl) environment.URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
  function cancelCapture() {
    captureVersion++;
    transcriptionController?.abort();
    transcriptionController = null;
    clearTimer(transcriptionTimer);
    transcriptionTimer = null;
    const active = recorder;
    recorder = null;
    if (active && active.state !== "inactive") {
      try { active.stop(); } catch { /* Tracks still need releasing if the recorder already failed. */ }
    }
    releaseMicrophone();
    state.recording = false;
    state.capturing = false;
    state.transcribing = false;
    captureStatus = "";
    notify();
  }
  function stopPlayback() {
    playbackVersion++;
    playbackController?.abort();
    playbackController = null;
    resumeAudio = null;
    clearTimer(playbackTimer);
    playbackTimer = null;
    releaseAudio();
    state.speaking = false;
    state.needsPlaybackGesture = false;
    playbackStatus = "";
    notify();
  }
  function cancel() {
    cancelCapture();
    stopPlayback();
  }
  function resumePlayback() {
    return state.needsPlaybackGesture && resumeAudio ? resumeAudio() : Promise.resolve(false);
  }
  async function serviceFailure(response, fallback) {
    try {
      const result = await response.json();
      return typeof result.error === "string" ? result.error : fallback;
    } catch { return fallback; }
  }

  async function startRecording({ deviceId = "" } = {}) {
    if (state.capturing || state.transcribing) return false;
    stopPlayback();
    if (!supported) {
      failure("Microphone recording is unavailable in this browser. Use a browser with microphone support on localhost or HTTPS, or type your argument.");
      return false;
    }
    const version = ++captureVersion;
    measuredInputSamples = 0; maximumInputRms = 0; captureHadMutedTrack = false;
    state.inputLevel = null; state.inputMonitoring = false; state.microphoneMuted = false;
    state.captureElapsedSeconds = 0; state.inputSignalDetected = false; state.microphoneLabel = "";
    state.capturing = true;
    captureStatus = "Waiting for microphone access…";
    notify();
    try {
      const acquired = await environment.navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      } });
      if (version !== captureVersion) { acquired.getTracks().forEach(track => track.stop()); return false; }
      stream = acquired;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find(type => Recorder.isTypeSupported?.(type));
      const active = new Recorder(acquired, mimeType ? { mimeType } : undefined);
      recorder = active;
      const chunks = [];
      let bytes = 0;
      active.ondataavailable = event => {
        if (version !== captureVersion || !event.data?.size) return;
        bytes += event.data.size;
        if (bytes > MAX_AUDIO_BYTES) {
          cancelCapture();
          failure("The recording exceeded 16 MiB. Record a shorter argument.");
          return;
        }
        chunks.push(event.data);
      };
      active.onerror = () => {
        if (version !== captureVersion) return;
        cancelCapture();
        failure("Microphone recording failed. Try again or type your argument.");
      };
      active.onstop = async () => {
        if (version !== captureVersion || recorder !== active) return;
        recorder = null;
        releaseMicrophone();
        state.recording = false;
        state.capturing = false;
        state.transcribing = true;
        captureStatus = "Transcribing your argument locally…";
        notify();
        const controller = new Controller();
        transcriptionController = controller;
        const timeout = setTimer(() => controller.abort(new Error("Transcription timed out. Try a shorter argument.")), SPEECH_TIMEOUT_MS);
        transcriptionTimer = timeout;
        try {
          const recording = new BlobType(chunks, { type: active.mimeType || chunks[0]?.type || "application/octet-stream" });
          if (!recording.size) throw new Error("No audio was recorded. Try again or type your argument.");
          const response = await environment.fetch("/api/speech/transcriptions", { method: "POST", body: recording, signal: controller.signal });
          if (!response.ok) throw new Error(await serviceFailure(response, "Could not transcribe your argument."));
          const result = await response.json();
          if (version !== captureVersion) return;
          controller.signal.throwIfAborted();
          if (typeof result.text !== "string" || !result.text.trim()) {
            if (captureHadMutedTrack && !state.inputSignalDetected) throw new Error("No speech was recognized because the microphone was muted or unavailable. Check your microphone input and try again.");
            if (measuredInputSamples >= 10 && maximumInputRms < 0.0001) throw new Error("No speech was recognized. The microphone recording was silent. Check your microphone input and volume, then try again.");
            throw new Error("No speech was recognized in the recording. Check your microphone input and try a longer clear phrase, or type your argument.");
          }
          options.onTranscript?.(result.text.trim());
          if (version === captureVersion) captureStatus = "Transcript ready. Review your argument, then send it.";
        } catch (error) {
          if (version === captureVersion) {
            captureStatus = "";
            failure(controller.signal.aborted ? controller.signal.reason?.message || "Transcription canceled." : error.message || "Could not transcribe your argument.");
          }
        } finally {
          clearTimer(timeout);
          if (version === captureVersion) { transcriptionController = null; transcriptionTimer = null; state.transcribing = false; notify(); }
        }
      };
      active.start(250);
      state.recording = true;
      captureStartedAt = now();
      captureStatus = "Recording your argument… Stop when you are ready. Recording ends automatically before two minutes.";
      recordingTimer = setTimer(stopRecording, MAX_RECORDING_MS);
      monitorMicrophone(acquired, version);
      notify();
      return true;
    } catch (error) {
      if (version !== captureVersion) return false;
      cancelCapture();
      const message = error.name === "NotAllowedError" || error.name === "SecurityError" ? "Microphone access was denied. Allow microphone access to speak, or type your argument." :
        error.name === "NotFoundError" ? "No microphone was found. Connect one or type your argument." : "Could not start the microphone. Check that it is available, or type your argument.";
      failure(message);
      return false;
    }
  }
  function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    clearTimer(recordingTimer);
    recordingTimer = null;
    state.recording = false;
    captureStatus = "Finishing your recording…";
    notify();
    try { recorder.stop(); }
    catch { cancelCapture(); failure("Could not finish the recording. Try again or type your argument."); }
  }

  async function play(text) {
    if (state.capturing || state.transcribing) { failure("Finish or cancel your recording before playing a response."); return false; }
    stopPlayback();
    captureStatus = "";
    const chunks = splitSpeechText(text);
    if (!chunks.length) return false;
    if (!environment.Audio || !environment.URL?.createObjectURL) { failure("Audio playback is unavailable in this browser. You can still read the response."); return false; }
    const version = ++playbackVersion;
    const controller = new Controller();
    playbackController = controller;
    state.speaking = true;
    playbackStatus = "Preparing spoken response…";
    notify();
    try {
      for (const chunk of chunks) {
        playbackTimer = setTimer(() => controller.abort(new Error("Speech generation timed out. Use Replay to try again.")), SPEECH_TIMEOUT_MS);
        const response = await environment.fetch("/api/speech/audio", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: chunk }), signal: controller.signal });
        if (!response.ok) throw new Error(await serviceFailure(response, "Could not generate the spoken response."));
        const blob = await response.blob();
        if (version !== playbackVersion) return false;
        controller.signal.throwIfAborted();
        if (!blob.size) throw new Error("The speech service returned no audio. Use Replay to try again.");
        clearTimer(playbackTimer);
        playbackTimer = null;
        audioUrl = environment.URL.createObjectURL(blob);
        if (!audio) audio = new environment.Audio();
        const playing = audio;
        playing.src = audioUrl;
        playbackStatus = "Speaking the response…";
        notify();
        await new Promise((resolve, reject) => {
          let settled = false;
          let attemptVersion = 0;
          const finish = error => {
            if (settled) return;
            settled = true;
            if (playing.onended === ended) playing.onended = null;
            if (playing.onerror === playbackError) playing.onerror = null;
            if (resumeAudio === attempt) resumeAudio = null;
            controller.signal.removeEventListener("abort", aborted);
            if (error) reject(error); else resolve();
          };
          const aborted = () => finish(controller.signal.reason || new Error("Speech canceled."));
          const ended = () => finish();
          const playbackError = () => finish(new Error("Could not play the spoken response. Use Replay to try again."));
          const attempt = () => {
            if (settled || version !== playbackVersion || controller.signal.aborted) return Promise.resolve(false);
            const currentAttempt = ++attemptVersion;
            const blocked = error => {
              if (settled || version !== playbackVersion || currentAttempt !== attemptVersion) return false;
              if (error?.name === "NotSupportedError") { finish(new Error("Could not play this audio format. You can still read the response.")); return false; }
              state.needsPlaybackGesture = true;
              playbackStatus = "Audio ready. Select Play audio to listen.";
              notify();
              return false;
            };
            try {
              return Promise.resolve(playing.play()).then(() => {
                if (settled || version !== playbackVersion || currentAttempt !== attemptVersion) return false;
                state.needsPlaybackGesture = false;
                playbackStatus = "Speaking the response…";
                notify();
                return true;
              }, blocked);
            } catch (error) { return Promise.resolve(blocked(error)); }
          };
          resumeAudio = attempt;
          playing.onended = ended;
          playing.onerror = playbackError;
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) { aborted(); return; }
          void attempt();
        });
        if (version !== playbackVersion) return false;
        clearTimer(playbackTimer);
        playbackTimer = null;
        releaseAudio();
        if (version !== playbackVersion) return false;
        playbackStatus = "Preparing the next spoken passage…";
        notify();
      }
      return true;
    } catch (error) {
      if (version === playbackVersion) failure(controller.signal.aborted ? controller.signal.reason?.message || "Speech canceled." : error.message || "Could not play the response.");
      return false;
    } finally {
      if (version === playbackVersion) {
        clearTimer(playbackTimer);
        playbackTimer = null;
        releaseAudio();
        playbackController = null;
        state.speaking = false;
        state.needsPlaybackGesture = false;
        playbackStatus = "";
        notify();
      }
    }
  }
  return { startRecording, stopRecording, stopPlayback, resumePlayback, cancel, play, get state() { return snapshot(); } };
}
