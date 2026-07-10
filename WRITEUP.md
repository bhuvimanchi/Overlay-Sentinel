# Overlay Sentinel — Write-up

## What we built

Overlay Sentinel is a **zero-install web tool that detects when an interview candidate is using a hidden AI "copilot" overlay** (Cluely, Parakeet, FinalRound AI, and similar) during a live remote interview. These tools listen to the interviewer's question and feed the candidate an answer on a floating teleprompter that is deliberately invisible to screen sharing and recording — so the obvious defenses (watch the shared screen, check the task manager) see nothing, and the zero-install constraint rules out putting an agent on the candidate's machine.

Our key insight: **you can't see the overlay, but the candidate still has to read the answer and say it out loud — and that behavior cannot go stealth.** So we detect the *use* of a copilot rather than the software itself, using only what a normal web page can legitimately observe with the candidate's consent. The product is a Next.js app: a candidate page (webcam gaze tracking via MediaPipe, speech capture, environment scan), a reviewer dashboard (live risk score, per-question evidence, signal timeline over Server-Sent Events), and a server-side scoring engine.

## How it detects

Eight independent signals feed a weighted, capped risk score that lands in one of three bands — **clean / suspicious / high-risk**:

- **Reading-pattern gaze** (strong) — MediaPipe face mesh detects *line-sweep saccades*: slow horizontal drift then a fast return jump, the eye signature of reading text line by line. Spontaneous speakers don't sweep like that.
- **LLM answer similarity** (strong) — the transcript is scored for how much it looks like a generated answer read aloud (structured, complete, no human disfluency) — via a free local heuristic by default, or Groq/Claude if a key is set.
- **Off-camera fixation** (medium) — sustained gaze locked away from the camera while "answering"; the overlay sits in a fixed screen region.
- **Uniform answer latency** (medium) — copilots need a flat ~2–5 s to transcribe and generate; humans are fast on easy questions and slow on hard ones.
- **Virtual audio device** (medium) — copilots capture interviewer audio via VB-Cable/BlackHole/Voicemeeter, visible to `enumerateDevices()`.
- **Screen-share evasion** (medium) — declining or downgrading the full-monitor share, or killing it mid-interview.
- **Window blur mid-answer** and **multiple displays** (weak, deliberately low weight) — honest people alt-tab and own second monitors.

Heavy weight goes to behaviors that are hard to explain *without* an invisible prompter; each signal's contribution is capped so one noisy reading can't run the score away. The output is an **advisory signal for a human reviewer with the evidence behind every point — never an automatic reject**. Privacy is by design: raw webcam video never leaves the browser (only derived numbers like sweep counts), and the session starts with an explicit consent step.

## Coverage and limits — honestly

We reliably catch the common case: a candidate reading copilot output from an on-screen overlay. We do **not** catch everything, and we don't claim to:

- **Second device** — an answer read off a phone propped beside the screen leaves no gaze-to-screen correlation. This is our biggest gap.
- **Human whisperer** — a person feeding answers over an earpiece looks like a thoughtful candidate.
- **Well-prepared candidates** who naturally answer in structured, complete prose can nudge the LLM-similarity signal — which is exactly why it is one weighted input among eight, not a verdict.
- **Gaze quality** depends on a reasonably lit, front-facing webcam; heavy glasses glare degrades it. Speech capture is Chrome-tuned and English-tuned.
- **Environment flags** are individually weak and easy to defeat; they matter only stacked with the behavioral signals.

The design goal is clever, working, *defensible* detection with a clear-eyed view of what it can't do. The overlay is invisible; the behavior isn't.
