"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GazeTracker } from "@/lib/client/gaze";
import { startAnswerRecording, type AnswerRecorder } from "@/lib/client/recorder";
import {
  runEnvironmentScan,
  requestMonitorShare,
  postEvent,
} from "@/lib/client/environment";
import type { QA, Session } from "@/lib/store";

type Phase = "setup" | "live" | "done";

function CandidateSession({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [status, setStatus] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [progress, setProgress] = useState({ answered: 0, total: 0 });
  const [activeQuestion, setActiveQuestion] = useState<QA | null>(null);
  const [gazeDot, setGazeDot] = useState({ x: 0, y: 0 });
  const [answerText, setAnswerText] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState(false);
  const [micDevices, setMicDevices] = useState<{ id: string; label: string }[]>([]);
  const [micId, setMicId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const recorderRef = useRef<AnswerRecorder | null>(null);
  const micIdRef = useRef("");
  const activeQuestionRef = useRef<QA | null>(null);

  // Single persistent <video>. Rendered once, at the top, for both phases —
  // so the camera stream is never orphaned by a phase swap.
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackerRef = useRef<GazeTracker | null>(null);
  const answeredIds = useRef<Set<string>>(new Set());
  const currentQuestionShownAt = useRef<number>(0);

  const log = (s: string) => setStatus((prev) => [...prev, s]);

  const beginSetup = useCallback(async () => {
    setStarting(true);
    setStatus([]); // fresh checklist on each attempt (retries don't stack)

    // No step is allowed to hang silently — everything either succeeds,
    // fails with a visible reason, or times out with a visible reason.
    const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
      Promise.race([
        p,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms),
        ),
      ]);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        log(
          "✗ Camera API unavailable — open this page via http://localhost:3000 (or HTTPS). Browsers block camera access on plain network IPs.",
        );
        setStarting(false);
        return;
      }

      log("Requesting camera + microphone… (if a permission popup appears, click Allow)");
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: true,
        }),
        30000,
        "camera permission",
      );
      // We only need video for the preview + gaze. Release the mic captured by
      // getUserMedia (permission persists) so it doesn't starve the answer
      // recorder.
      stream.getAudioTracks().forEach((t) => t.stop());
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
      log("✓ Camera on");

      // Enumerate microphones (labels are available now that permission is
      // granted) so the candidate can pick their real mic — the system
      // default is sometimes a virtual/silent device.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices
          .filter((d) => d.kind === "audioinput" && d.deviceId !== "default")
          .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
        setMicDevices(mics);
        const saved = localStorage.getItem("sentinel_mic") ?? "";
        if (saved && mics.some((m) => m.id === saved)) {
          setMicId(saved);
          micIdRef.current = saved;
        }
      } catch {
        /* device list unavailable — default mic will be used */
      }

      log("Loading gaze model (downloads ~10MB on first run)…");
      try {
        const tracker = new GazeTracker();
        tracker.onSample = (x, y) => setGazeDot({ x, y });
        tracker.onFaceChange = (detected) => {
          setFaceDetected(detected);
          fetch("/api/events", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, type: "candidate.face", detected }),
          }).catch(() => {});
        };
        await withTimeout(tracker.start(videoRef.current!), 30000, "gaze model download");
        trackerRef.current = tracker;
        log("✓ Gaze model loaded");
      } catch (gazeErr) {
        // Gaze is one signal of several — degrade gracefully, don't brick setup.
        log(
          `⚠ Gaze unavailable (${(gazeErr as Error).message}) — continuing without gaze signals`,
        );
      }

      const flags = await runEnvironmentScan();
      for (const f of flags) await postEvent(sessionId, f);
      log(`✓ Environment scan (${flags.length} flag${flags.length === 1 ? "" : "s"})`);

      log("Requesting full-monitor screen share…");
      await requestMonitorShare((f) => postEvent(sessionId, f));
      log("✓ Screen share step complete");

      await postEvent(sessionId, {
        type: "candidate.connected",
        severity: "info",
        summary: "Candidate joined",
      });
      setPhase("live");
      log("You're live. Your first question is on its way.");
    } catch (err) {
      const e = err as Error;
      let hint = "";
      if (e.name === "NotAllowedError")
        hint = " — camera/mic permission was denied. Click the camera icon in the address bar, allow access, and try again.";
      else if (e.name === "NotReadableError")
        hint = " — the camera is in use by another app or tab. Close other tabs/apps using the camera (including old candidate tabs) and try again.";
      else if (e.name === "NotFoundError")
        hint = " — no camera/microphone found on this machine.";
      log(`✗ Setup failed: ${e.message}${hint}`);
      setStarting(false);
    }
  }, [sessionId]);

  // Subscribe to the session stream: receive questions in order, and detect
  // session completion.
  useEffect(() => {
    if (phase !== "live") return;
    const es = new EventSource(`/api/stream?session=${sessionId}`);
    es.onmessage = (ev) => {
      const { session } = JSON.parse(ev.data) as { session: Session };
      setCandidateName(session.candidateName);
      setProgress({
        answered: session.qas.filter((q) => q.answeredAt).length,
        total: session.qas.length,
      });

      if (session.status === "completed") {
        setActiveQuestion(null);
        activeQuestionRef.current = null;
        setPhase("done");
        return;
      }

      // Next question = first unanswered (skip any we've locally submitted).
      const next = session.qas.find(
        (q) => !q.answeredAt && !answeredIds.current.has(q.id),
      );
      if (next) {
        setActiveQuestion((cur) => {
          if (cur && cur.id === next.id) return cur;
          currentQuestionShownAt.current = Date.now();
          setAnswerText("");
          setMicError(false);
          setMicLevel(0);
          trackerRef.current?.beginAnswerWindow();
          // Single mic consumer: record audio (transcribed via Whisper on
          // submit) with a live level meter + voice-activity latency. Stop any
          // straggler recorder first so the mic is never double-held.
          const straggler = recorderRef.current;
          recorderRef.current = null;
          const startFresh = () =>
            startAnswerRecording((rms) => setMicLevel(rms), micIdRef.current || undefined).then(
              (r) => {
                recorderRef.current = r;
                if (!r) setMicError(true);
              },
            );
          if (straggler) straggler.stop().finally(startFresh);
          else startFresh();
          activeQuestionRef.current = next;
          return next;
        });
      }
    };
    return () => es.close();
  }, [phase, sessionId]);

  // Switch microphone — takes effect immediately, restarting the current
  // answer's recorder on the new device. (Audio recorded so far on the silent
  // device is discarded; that's the point of switching.)
  const switchMic = async (id: string) => {
    setMicId(id);
    micIdRef.current = id;
    try {
      localStorage.setItem("sentinel_mic", id);
    } catch {
      /* private mode */
    }
    if (activeQuestionRef.current) {
      const old = recorderRef.current;
      recorderRef.current = null;
      if (old) await old.stop();
      setMicLevel(0);
      const r = await startAnswerRecording((rms) => setMicLevel(rms), id || undefined);
      recorderRef.current = r;
      setMicError(!r);
    }
  };

  const submitAnswer = async () => {
    if (!activeQuestion || submitting) return;
    const qa = activeQuestion;
    setSubmitting(true);

    // Capture everything for this question, then clear it IMMEDIATELY —
    // before any await. The server broadcast that follows our POST makes the
    // SSE handler load the next question; a trailing setActiveQuestion(null)
    // here would race it and wipe the freshly-loaded question (the "second
    // question never appears" bug).
    const gaze = trackerRef.current?.endAnswerWindow();
    const shownAt = currentQuestionShownAt.current;
    const typed = answerText.trim();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    answeredIds.current.add(qa.id);
    activeQuestionRef.current = null;
    setActiveQuestion(null);

    const recording = recorder
      ? await recorder.stop()
      : { audio: null, firstSpeechAt: null };

    // Typed answer wins; otherwise transcribe the recorded audio via Whisper.
    let transcriptToSend = typed;
    if (transcriptToSend.length < 12 && recording.audio) {
      try {
        const fd = new FormData();
        fd.append("audio", recording.audio, "answer.webm");
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = await res.json();
        if (data.text) transcriptToSend = data.text;
      } catch {
        /* transcription unavailable — submit whatever we have */
      }
    }

    const latencyMs = recording.firstSpeechAt
      ? recording.firstSpeechAt - shownAt
      : undefined;

    await fetch("/api/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        qaId: qa.id,
        latencyMs,
        transcript: transcriptToSend,
        gaze,
      }),
    });
    setSubmitting(false);
  };

  // Weak signal: interview window losing focus mid-answer.
  useEffect(() => {
    if (phase !== "live") return;
    let lastReport = 0;
    const report = (what: string) => {
      if (!activeQuestionRef.current) return; // only while answering
      const now = Date.now();
      if (now - lastReport < 10000) return;
      lastReport = now;
      postEvent(sessionId, {
        type: "env.window_blur",
        severity: "weak",
        summary: `Interview window lost focus while answering (${what})`,
      });
    };
    const onBlur = () => report("window blur");
    const onVis = () => {
      if (document.hidden) report("tab hidden");
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [phase, sessionId]);

  return (
    <main>
      <h1>Candidate session{candidateName ? ` — ${candidateName}` : ""}</h1>
      {phase === "live" && progress.total > 0 && (
        <p className="muted" style={{ marginBottom: 12 }}>
          Question {Math.min(progress.answered + 1, progress.total)} of {progress.total}
        </p>
      )}

      {phase !== "done" && (
        <div className="panel" style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <video
              ref={videoRef}
              className="preview"
              muted
              playsInline
              style={{ maxWidth: 240, display: "block" }}
            />
            {!cameraOn && (
              <span
                className="muted"
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.85rem",
                }}
              >
                camera off
              </span>
            )}
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <p className="muted">Gaze (live)</p>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: !cameraOn
                    ? "var(--muted)"
                    : faceDetected
                      ? "var(--green)"
                      : "var(--amber)",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: !cameraOn
                      ? "var(--border)"
                      : faceDetected
                        ? "var(--green)"
                        : "var(--amber)",
                  }}
                />
                {!cameraOn ? "no camera" : faceDetected ? "face detected" : "no face"}
              </span>
            </div>
            <div
              style={{
                position: "relative",
                width: 160,
                height: 120,
                background: "var(--panel2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                marginTop: 6,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: cameraOn ? "var(--accent)" : "var(--border)",
                  left: `calc(50% + ${gazeDot.x * 60}px - 7px)`,
                  top: `calc(50% - ${gazeDot.y * 45}px - 7px)`,
                  transition: "all 0.1s",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {phase === "setup" && (
        <div className="panel">
          <h2>Consent &amp; setup</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            This interview uses integrity monitoring. With your consent we
            analyze webcam gaze, scan for virtual audio devices, and request a
            screen share. Nothing is installed on your machine and raw video is
            not stored — only derived signals.
          </p>
          <ul className="checklist" style={{ margin: "0 0 16px" }}>
            {status.map((s, i) => (
              <li key={i} className={s.startsWith("✗") ? "" : "done"}>
                {s}
              </li>
            ))}
          </ul>
          <button onClick={beginSetup} disabled={starting}>
            I consent — begin setup
          </button>
        </div>
      )}

      {phase === "live" &&
        (activeQuestion ? (
          <div className="panel">
            <p className="muted">Interviewer asks:</p>
            <div className="question-box" style={{ margin: "10px 0 16px" }}>
              {activeQuestion.question}
            </div>

            {micDevices.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: "0.82rem" }}>
                  Microphone:
                </span>
                <select
                  value={micId}
                  onChange={(e) => switchMic(e.target.value)}
                  style={{
                    background: "var(--panel2)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "4px 8px",
                    fontSize: "0.82rem",
                    maxWidth: 340,
                  }}
                >
                  <option value="">System default</option>
                  {micDevices.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: "0.85rem", minWidth: 70 }}>
                🎙 mic level
              </span>
              <div
                style={{
                  flex: 1,
                  maxWidth: 260,
                  height: 10,
                  background: "var(--panel2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, micLevel * 600)}%`,
                    height: "100%",
                    background: micLevel > 0.02 ? "var(--green)" : "var(--border)",
                    transition: "width 0.1s",
                  }}
                />
              </div>
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {micError
                  ? ""
                  : micLevel > 0.02
                    ? "hearing you ✓"
                    : "speak — if the bar doesn't move, pick another microphone above"}
              </span>
            </div>

            {micError && (
              <p style={{ color: "var(--red)", fontSize: "0.82rem", marginBottom: 8 }}>
                ⚠ microphone unavailable — check Windows mic permissions /
                default input device, or type your answer below.
              </p>
            )}

            <label className="muted" style={{ fontSize: "0.82rem" }}>
              Answer transcript (transcribed automatically when you press done —
              or type here):
            </label>
            <textarea
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              rows={4}
              placeholder="Speak your answer, then press done — the transcript appears here…"
              style={{ margin: "6px 0 12px" }}
            />

            <button onClick={submitAnswer} disabled={submitting}>
              {submitting ? "Transcribing & submitting…" : "Done answering"}
            </button>
            <p className="muted" style={{ marginTop: 8, fontSize: "0.75rem" }}>
              Watch the mic bar while you speak — if it doesn&apos;t move, your
              microphone isn&apos;t picking you up.
            </p>
          </div>
        ) : (
          <div className="panel">
            <p className="muted">Loading next question…</p>
          </div>
        ))}

      {phase === "done" && (
        <div className="panel" style={{ textAlign: "center", padding: 40 }}>
          <h2>✅ All questions answered</h2>
          <p className="muted" style={{ marginTop: 8 }}>
            Your session is complete — you can close this window. Thank you!
          </p>
        </div>
      )}
    </main>
  );
}

function CandidateEntry() {
  const searchParams = useSearchParams();
  const sessionFromUrl = searchParams.get("s") ?? "";
  const [code, setCode] = useState("");
  const [joined, setJoined] = useState(sessionFromUrl);

  if (!joined) {
    return (
      <main>
        <h1>Join your interview</h1>
        <div className="panel">
          <p className="muted" style={{ marginBottom: 12 }}>
            Paste the session code or link your interviewer sent you.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              placeholder="session code, e.g. a1b2c3d4"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && code.trim() && setJoined(code.trim().split("s=").pop()!)}
            />
            <button onClick={() => code.trim() && setJoined(code.trim().split("s=").pop()!)}>
              Join
            </button>
          </div>
        </div>
      </main>
    );
  }
  return <CandidateSession sessionId={joined} />;
}

export default function CandidatePage() {
  return (
    <Suspense fallback={<main><p className="muted">Loading…</p></main>}>
      <CandidateEntry />
    </Suspense>
  );
}
