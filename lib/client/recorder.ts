"use client";

// Sole owner of the microphone during an answer. Records audio for Whisper
// transcription, reports a live input level (so the candidate can SEE the mic
// hearing them), and detects when speech first starts (for the latency
// signal) via a simple RMS voice-activity check.
//
// We deliberately do NOT run the Web Speech API alongside this — two
// simultaneous mic consumers starve each other on Windows/Chrome, which
// manifests as "it isn't hearing me".

export interface AnswerRecording {
  audio: Blob | null;
  firstSpeechAt: number | null; // epoch ms when voice activity first detected
}

export interface AnswerRecorder {
  stop: () => Promise<AnswerRecording>;
}

export async function startAnswerRecording(
  onLevel?: (rms: number) => void,
  deviceId?: string,
): Promise<AnswerRecorder | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
  } catch {
    if (deviceId) {
      // Selected device gone — fall back to the system default.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return null;
      }
    } else {
      return null; // mic unavailable — caller shows a typed-answer fallback
    }
  }

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const rec = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  rec.start(1000); // 1s chunks so nothing is lost on stop

  // Level meter + voice-activity detection on the same stream.
  const ctx = new AudioContext();
  ctx.resume().catch(() => {});
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let firstSpeechAt: number | null = null;
  let hotFrames = 0;
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.(rms);
    if (firstSpeechAt === null) {
      if (rms > 0.02) {
        hotFrames++;
        if (hotFrames >= 2) firstSpeechAt = Date.now() - 200; // detection lag
      } else {
        hotFrames = 0;
      }
    }
  }, 100);

  return {
    stop: () =>
      new Promise((resolve) => {
        clearInterval(meter);
        ctx.close().catch(() => {});
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve({
            audio: chunks.length ? new Blob(chunks, { type: "audio/webm" }) : null,
            firstSpeechAt,
          });
        };
        try {
          rec.stop();
        } catch {
          stream.getTracks().forEach((t) => t.stop());
          resolve({ audio: null, firstSpeechAt });
        }
      }),
  };
}
