# Overlay Sentinel — Full Guide & Presentation Kit

Everything you need to understand, test, and present the project.

---

## Part 1 — What we built (the one-liner and the longer story)

**One-liner:** A zero-install web tool that detects when an interview candidate is using a hidden AI "copilot" overlay (Cluely, Parakeet, FinalRound AI) — by watching the candidate's *behavior*, not hunting for the software.

**The problem (from the challenge):** AI interview copilots listen to the interviewer's question and silently feed the candidate an answer on a floating teleprompter. They're built to be invisible to screen sharing and screen recording — even in "stealth mode" they hide from the taskbar and recordings. Traditional proctoring (look at the shared screen, check task manager) sees nothing, because that's exactly what these tools are designed to defeat.

**Two hard constraints the challenge imposes:**
1. **Zero install** — you can't put any app, agent, or browser extension on the candidate's machine. Whatever you build runs inside the interview web page itself.
2. **Beat stealth mode** — the overlay excludes itself from screen capture, so looking at the shared screen is useless.

**Our key insight:** You can't see the overlay — but the candidate still has to *read* the answer off it and *say it out loud*, and the copilot still has to *listen and generate*. **That behavior cannot go stealth.** So we detect the *use* of a copilot, not the copilot software. Every step it forces the candidate through leaks a signal a normal web page can legitimately observe with consent: their eyes track across text that isn't on the shared screen, their answers arrive after a suspiciously uniform delay, and the words they say match what an LLM would generate.

---

## Part 2 — How it works (the signal stack)

We combine several independent signals. No single one is a smoking gun; stacked together and weighted, they separate an honest candidate from a copilot user. Each signal feeds a **risk score** that lands in one of three bands: **clean / suspicious / high-risk**.

| # | Signal | Strength | What it observes | Why a copilot triggers it |
|---|--------|----------|------------------|---------------------------|
| 1 | **Reading-pattern gaze** | strong | Webcam → MediaPipe face mesh → eye direction. We detect *line-sweep saccades*: slow horizontal drift then a fast return jump, repeated — the eye signature of reading text line by line. | The candidate is reading a generated answer off the overlay. Spontaneous speakers don't sweep like that. |
| 2 | **Off-camera fixation** | medium | Fraction of the answer where gaze is locked away from the camera. | Copilot overlay sits in a fixed screen region; the candidate stares there while "answering." |
| 3 | **LLM answer similarity** | strong | Server sends the transcribed answer to Claude, which judges how much it looks like a generated answer read aloud vs. spontaneous human speech. | The answer *is* LLM output, so it scores high on structure/completeness and low on human disfluency. |
| 4 | **Uniform answer latency** | medium | Time from question shown → first spoken word, across all questions. | The copilot needs a fixed ~2–5s to transcribe + generate, so delays are flat. Humans are fast on easy questions, slow on hard ones. |
| 5 | **Virtual audio device** | medium | `navigator.mediaDevices.enumerateDevices()` — looks for VB-Cable, BlackHole, Voicemeeter, etc. | Copilots need to capture the interviewer's audio; a virtual cable is the common way. |
| 6 | **Screen-share evasion** | medium | Whether the candidate shares the full monitor, downgrades to a window/tab, or kills the share mid-interview. | The challenge itself says: evasion is a signal. |
| 7 | **Multiple displays** | weak (low weight on purpose) | `screen.isExtended`. | A second monitor is a convenient place for an overlay — but *lots* of honest people have two monitors, so we weight this low to avoid false alarms. |

**Scoring philosophy (why the weights look the way they do):** We deliberately put heavy weight on behaviors that are hard to explain *without* an invisible prompter (reading-pattern gaze, LLM-matching answers) and light weight on things an honest person legitimately does (second monitor, one slow answer). The score is **capped** per signal so one noisy reading can't run the score away. The output is explicitly an **advisory signal for a human reviewer — never an automatic reject.** That's both an ethical requirement and a scoring requirement in the challenge.

**The data flow, end to end:**
```
Candidate browser                    Server (Next.js)              Reviewer browser
─────────────────                    ────────────────              ────────────────
webcam → MediaPipe gaze  ─┐
mic → Web Speech API      ├─ POST /api/answer ─→  scoring engine ─→ SSE /api/stream ─→ live dashboard
enumerateDevices, etc.    ┘   POST /api/events      (lib/scoring)      (risk + evidence + timeline)
                                                          │
question typed here ←──── SSE /api/stream ←── POST /api/question ←──── reviewer asks
                                              transcript → Claude (lib/similarity) → similarity score
```

---

## Part 3 — Architecture (what lives where)

- **Framework:** Next.js (App Router) — one app serves the candidate page, the reviewer dashboard, and the API.
- **Browser detection** (`lib/client/`):
  - `gaze.ts` — MediaPipe FaceLandmarker; per-answer gaze window; sweep + off-screen detection.
  - `speech.ts` — Web Speech API wrapper; running transcript + first-word timestamp (for latency).
  - `environment.ts` — device scan, screen-share request, event posting.
- **Server** (`lib/`):
  - `store.ts` — in-memory session state + Server-Sent-Events broadcast to both pages.
  - `scoring.ts` — the weighted, capped risk engine.
  - `similarity.ts` — the Anthropic (Claude) answer-similarity call; returns `null` gracefully if no API key.
- **API routes** (`app/api/`): `question`, `answer`, `events`, `stream` (SSE), `reset`.
- **Pages** (`app/`): `/` (landing), `/candidate`, `/reviewer`.
- **Transport:** everything is pushed live over SSE — no polling, no refresh.

**Privacy by design:** raw webcam video never leaves the browser — only *derived* numbers (gaze ratios, sweep counts) are sent. The candidate page opens with an explicit consent step. This matches the challenge's "respect privacy / get consent / don't store more than you need" rule.

---

## Part 4 — How to test it

### Prerequisites
- Node.js installed, Chrome browser (Web Speech API + `getDisplayMedia` are best in Chrome).
- Optional: an Anthropic API key to turn on signal #3 (LLM similarity). Without it, the other six signals still run.

### Start it
```bash
cd C:\Users\appuc\OneDrive\Desktop\overlay-sentinel
npm install       # first time only
npm run dev
```
Open the URL it prints (http://localhost:3000, or 3001 if 3000 is busy).

To enable LLM similarity, create `.env.local` with:
```
ANTHROPIC_API_KEY=sk-ant-...
```
then restart `npm run dev`.

### The live demo (the one to show judges)
1. Open **`/reviewer`** in one window (this is the interviewer's screen).
2. Open **`/candidate`** in another window — ideally a second machine, or at least a second monitor. Click **"I consent — begin setup"** and allow camera, mic, and screen share.
3. From the reviewer window, **ask a question** (type one or click a quick-pick).
4. On the candidate window, answer out loud, then press **"Done answering."**
5. Watch the reviewer dashboard: the risk score, per-question evidence table, and signal timeline update live.

**Run it twice for contrast:**
- **Honest run:** answer naturally, look at the camera. → stays **clean** (score near 0).
- **Cheating run:** open an actual copilot overlay (or just read a pre-written answer off a doc positioned to one side of your screen while glancing at it). → **reading-pattern** and **off-camera** fire, latency flattens, and with an API key the **LLM-match** fires → score climbs into **suspicious / high-risk**.

Asking 2–3 questions in the cheating run stacks contributions and pushes it firmly into high-risk.

### The fast API smoke test (no camera needed — proves the pipeline)
This is what we ran to verify scoring. It drives the server directly:
```bash
BASE=http://localhost:3001   # match your port

# cheating-shaped answer
curl -s -X POST $BASE/api/reset
curl -s -X POST $BASE/api/events -H "Content-Type: application/json" \
  -d '{"type":"env.virtual_audio_device","severity":"medium","summary":"VB-Cable"}'
QID=$(curl -s -X POST $BASE/api/question -H "Content-Type: application/json" \
  -d '{"text":"Design a URL shortener."}' | node -pe "JSON.parse(require('fs').readFileSync(0)).id")
curl -s -X POST $BASE/api/answer -H "Content-Type: application/json" \
  -d "{\"qaId\":\"$QID\",\"latencyMs\":4200,\"transcript\":\"First you hash the URL, second you store the mapping, third you add caching, finally you handle collisions.\",\"gaze\":{\"offScreenRatio\":0.72,\"sweepCount\":5,\"samples\":90}}"

# read the computed risk
curl -s -N --max-time 3 $BASE/api/stream | head -1
```
Expected: risk in the **suspicious** band with reading-pattern, off-camera, and virtual-audio contributions. Re-run with `sweepCount:0, offScreenRatio:0.1` and a disfluent transcript → **clean, score 0**. (This is exactly the honest-vs-cheating contrast we verified.)

---

## Part 5 — Honest limits (say these out loud — the challenge rewards it)

- **Second device.** If the candidate reads off a phone propped beside the screen, there's no gaze-to-screen correlation to catch — this is the biggest gap.
- **Human whisperer.** A person on an earpiece feeding answers looks like… a thoughtful candidate.
- **A genuinely well-prepared candidate** who happens to answer in structured, complete prose can nudge the LLM-similarity signal — which is exactly why it's one weighted input, not a verdict.
- **Gaze quality** depends on a lit, front-facing webcam; heavy glasses glare degrades it.
- **Speech capture** uses the Web Speech API — Chrome-only, and tuned for English here.
- **Environment flags** are individually weak and easy to defeat; they only matter stacked with behavioral signals.

We don't claim to catch every tool. We claim clever, working, defensible detection of the *common* case, with a clear-eyed view of what it can't do. (Overclaiming "100% detection" loses points in this challenge — we deliberately don't.)

---

## Part 6 — 3–5 minute presentation outline

**Slide 0 · Title (10s)**
> Overlay Sentinel — Catching the Invisible AI Cheater. [Your name].

**Slide 1 · The problem (40s)**
- AI copilots feed candidates answers on a teleprompter the interviewer never sees.
- Built to be invisible to screen share and recording — even in stealth mode.
- Two rules that make it hard: **zero install**, and it must **beat stealth mode**.
- *Punchline:* the obvious moves (look at the shared screen, check task manager) are exactly what these tools defeat.

**Slide 2 · The insight (30s)**
> You can't see the overlay. But the candidate has to **read** it and **say it out loud**, and the tool has to **listen and generate**. That behavior can't go stealth.
- So we detect the **use**, not the software — from a normal web page, with consent.

**Slide 3 · How it works — the signal stack (60s)**
- Show the 7-signal table (or the top 3): reading-pattern gaze, LLM answer-match, uniform latency; plus virtual-audio, screen-share evasion, second monitor.
- Emphasize: independent signals → **weighted, capped risk score** → clean / suspicious / high-risk.
- Emphasize: heavy weight on hard-to-explain behaviors, light weight on things honest people do.

**Slide 4 · LIVE DEMO (90s) — the centerpiece**
- Reviewer dashboard on screen. Ask a question.
- **Honest answer** → stays clean, score ~0. "A normal candidate on a normal laptop is not flagged."
- **Copilot answer** (overlay running) → reading-pattern + off-camera + LLM-match fire → score jumps to high-risk, with **evidence shown for every point**.
- Point at the per-question evidence table and the signal timeline: "not a black box — a reviewer sees exactly why."

**Slide 5 · Reviewer experience & ethics (30s)**
- Risk score + evidence + timeline; **advisory signal for a human, never an auto-reject.**
- Consent-first; raw video never leaves the browser, only derived signals.

**Slide 6 · Honest limits (30s)**
- Second device, human whisperer, well-prepared candidate, webcam quality.
- "We don't claim 100%. We claim clever, working, defensible detection — and we're honest about the gaps."

**Slide 7 · What's next (20s)**
- Correlate gaze direction with shared-screen content (catch reading from a region that shows nothing).
- Active probes: a visual question defeats audio-only copilots; interrupting mid-answer breaks scripted delivery.
- Per-candidate baseline calibration to further cut false alarms.

**Close (10s)**
> The overlay is invisible. The behavior isn't. Overlay Sentinel reads the behavior. Thank you.

### Mapping to the 100-point rubric (keep this in your back pocket)
- **Detection that works (35):** live demo fires correctly on the cheating run.
- **Creativity (20):** detect the *use* via gaze/reading + LLM-match, not the software.
- **Low false alarms (15):** honest run stays clean; low weights on innocent signals.
- **Reviewer experience (15):** dashboard with risk band + per-point evidence + timeline.
- **Honesty & rigor (15):** explicit limits slide; no overclaiming.
