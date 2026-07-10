# Overlay Sentinel

**Catch the Invisible AI Cheater** — a zero-install way to detect a candidate using a hidden AI interview copilot (Cluely, Parakeet, FinalRound AI, and similar) during a live remote interview.

## The core idea

You can't see the overlay — these tools exclude themselves from screen capture by design, so looking at the shared screen is a dead end. But the candidate still has to *read* the generated answer and *deliver* it, and the copilot still has to *listen and generate*. That behavior can't go stealth. **Overlay Sentinel detects the use, not the software**, using only what a normal web page can observe with consent.

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Put the reviewer dashboard on one screen and the candidate page on another (or another machine — best in Chrome).

**The LLM answer-similarity signal needs no paid key.** By default it runs a **local heuristic** (offline, free, no rate limits) that scores the read-an-LLM-answer linguistic signature. For a real model judgment, drop a **free Groq key** (`GROQ_API_KEY`, no credit card — <https://console.groq.com/keys>) into `.env.local`; if present it's used instead. An `ANTHROPIC_API_KEY` also works if you have one. See `.env.example`.

**Demo:** run one honest mock interview (stays *clean*), then one with a copilot overlay running in stealth mode (fires *reading-pattern* + *LLM-match* flags and crosses into *high-risk*).

## Signals

| Signal | Strength | How it works |
|---|---|---|
| Reading-pattern gaze | strong | MediaPipe FaceMesh in-browser; detects line-by-line sweep saccades during answers |
| Off-camera fixation | medium | Sustained gaze away from the camera while answering |
| LLM answer similarity | strong | Server scores how much the transcript looks like a read LLM answer — via a free local heuristic by default, or Groq/Claude if a key is set |
| Uniform answer latency | medium | A flat transcribe-and-generate delay across questions, where humans vary with difficulty |
| Virtual audio device | medium | `enumerateDevices()` — copilots capture interviewer audio via VB-Cable/BlackHole/etc. |
| Screen-share evasion | medium | Declining/downgrading the full-monitor share, or killing it mid-interview |
| Window blur mid-answer | weak | Interview tab/window losing focus while answering (catches alt-tab cheating; overlay copilots are click-through and won't trigger it) |
| Multiple displays | weak | `screen.isExtended` — deliberately low weight (honest second monitors exist) |

All signals feed a weighted, capped **risk score** → `clean` / `suspicious` / `high-risk`, shown on the reviewer dashboard with the evidence behind every point. It is an **advisory signal for a human**, never an auto-reject.

## Honest limits

- Can't catch a **second device** (phone propped beside the screen) — no gaze-to-screen correlation there.
- Can't catch a **human whisperer** on an earpiece, or a genuinely well-prepared candidate.
- Gaze reading-detection needs a reasonably lit, front-facing webcam; heavy glasses glare degrades it.
- Speech capture is dual-path: live captioning via the Web Speech API (Chrome), with recorded audio transcribed by Groq Whisper as the reliable fallback; the transcript box is also hand-editable. English-tuned here.
- Environment flags are weak on their own and easy to defeat; they matter only stacked with behavioral signals.

The design goal is *clever, working, defensible* detection with a clear-eyed view of what it can't do — not a claim of 100% coverage.

## Architecture

- **Next.js (App Router)** — candidate page, reviewer dashboard, API routes.
- **Browser** — `lib/client/`: gaze (MediaPipe), speech (Web Speech API), environment scan.
- **Server** — `lib/store.ts` (in-memory session + SSE broadcast), `lib/scoring.ts` (risk engine), `lib/similarity.ts` (Anthropic).
- **Transport** — Server-Sent Events (`/api/stream`) push live state to both pages.
