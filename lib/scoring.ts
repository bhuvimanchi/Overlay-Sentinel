import type { Session } from "./store";

export interface Contribution {
  label: string;
  points: number;
  evidence: string;
}

export interface RiskReport {
  score: number; // 0..100
  band: "clean" | "suspicious" | "high-risk";
  contributions: Contribution[];
}

// Weighted, capped signal aggregation. Weights are deliberately conservative on
// signals honest candidates can trigger (second monitor, one slow answer) and
// heavier on behaviors that require an invisible prompter to explain.
export function computeRisk(state: Session): RiskReport {
  const contributions: Contribution[] = [];
  const events = state.events;

  const capSum = (points: number[], cap: number) =>
    Math.min(cap, points.reduce((a, b) => a + b, 0));

  // 1. Gaze: line-reading pattern while answering (strong — requires on-screen text)
  const reading = events.filter((e) => e.type === "gaze.reading_pattern");
  if (reading.length > 0) {
    contributions.push({
      label: "Reading pattern while answering",
      points: capSum(reading.map(() => 14), 28),
      evidence: `${reading.length}× line-sweep eye movement detected during answers`,
    });
  }

  // 2. Gaze: sustained off-camera fixation during answers
  const offscreen = events.filter((e) => e.type === "gaze.offscreen_during_answer");
  if (offscreen.length > 0) {
    contributions.push({
      label: "Eyes off camera during answers",
      points: capSum(offscreen.map(() => 8), 16),
      evidence: `${offscreen.length}× answers delivered while fixated away from camera`,
    });
  }

  // 3. LLM answer similarity — confidence-scaled. A high-confidence match (a
  // genuine read-AI answer) is strong evidence and reaches "suspicious" on its
  // own; borderline matches (which an honest, well-structured answer can hit)
  // contribute little, to protect against false alarms.
  const simPer = (s: number) =>
    s >= 0.88 ? 22 : s >= 0.78 ? 14 : s >= 0.68 ? 6 : 0;
  const scored = state.qas
    .filter((q) => q.similarity != null && simPer(q.similarity) > 0)
    .map((q) => ({ q, pts: simPer(q.similarity!) }));
  if (scored.length > 0) {
    contributions.push({
      label: "Answers match LLM-generated output",
      points: Math.min(40, scored.reduce((a, s) => a + s.pts, 0)),
      evidence: scored
        .map(({ q }) => `"${q.question.slice(0, 40)}…" ${(q.similarity! * 100).toFixed(0)}%`)
        .join("; "),
    });
  }

  // 4. Flat answer-latency profile (copilot transcribe+generate delay)
  const latencies = state.qas
    .map((q) => q.latencyMs)
    .filter((l): l is number => typeof l === "number");
  if (latencies.length >= 3) {
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const stdev = Math.sqrt(
      latencies.reduce((a, b) => a + (b - mean) ** 2, 0) / latencies.length,
    );
    if (mean >= 2500 && mean <= 9000 && stdev < 900) {
      contributions.push({
        label: "Uniform answer delay",
        points: 14,
        evidence: `mean ${(mean / 1000).toFixed(1)}s, σ ${(stdev / 1000).toFixed(1)}s across ${latencies.length} answers — humans vary far more with question difficulty`,
      });
    }
  }

  // 5. Leaving the interview window while answering — the alt-tab cheater's
  // signature (switching to ChatGPT in another tab/window). Escalates with
  // repetition: one blur is a slip, several is navigating away for help.
  const blurs = events.filter((e) => e.type === "env.window_blur").length;
  if (blurs > 0) {
    contributions.push({
      label: "Left the interview window while answering",
      points: Math.min(26, 6 + (blurs - 1) * 7), // 1→6, 2→13, 3→20, 4→26
      evidence: `${blurs}× the interview tab/window lost focus mid-answer`,
    });
  }

  // 6. Smoking gun: tab-switching AND an answer that matches LLM output — the
  // candidate left the window and returned with an AI-shaped answer.
  const highSim = state.qas.some((q) => (q.similarity ?? 0) >= 0.78);
  if (blurs > 0 && highSim) {
    contributions.push({
      label: "Tab-switch paired with AI-matching answer",
      points: 12,
      evidence:
        "Left the interview window mid-answer and returned with an answer matching LLM output — the alt-tab-to-AI pattern",
    });
  }

  // 7. Environment flags (weak individually, meaningful stacked)
  const envFlags: Array<[string, string, number]> = [
    ["env.virtual_audio_device", "Virtual audio device present", 10],
    ["screen.not_full_monitor", "Declined full-monitor screen share", 8],
    ["screen.share_ended", "Screen share stopped mid-interview", 8],
    ["env.multi_screen", "Multiple displays detected", 4],
  ];
  for (const [type, label, pts] of envFlags) {
    const hit = events.find((e) => e.type === type);
    if (hit) contributions.push({ label, points: pts, evidence: hit.summary });
  }

  const score = Math.min(100, contributions.reduce((a, c) => a + c.points, 0));
  const band = score < 20 ? "clean" : score < 50 ? "suspicious" : "high-risk";
  return { score, band, contributions };
}
