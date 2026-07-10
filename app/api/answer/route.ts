import { NextRequest, NextResponse } from "next/server";
import { addEvent, updateQA, type GazeSummary } from "@/lib/store";
import { scoreAnswerSimilarity } from "@/lib/similarity";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, qaId, latencyMs, transcript, gaze } = body as {
    sessionId: string;
    qaId: string;
    latencyMs?: number;
    transcript?: string;
    gaze?: GazeSummary;
  };

  const result = updateQA(sessionId, qaId, {
    answeredAt: Date.now(),
    latencyMs,
    transcript,
    gaze,
  });
  if (!result)
    return NextResponse.json({ error: "unknown session/question" }, { status: 404 });
  const { qa } = result;

  // Gaze-derived events for this answer
  if (gaze && gaze.samples > 20) {
    if (gaze.sweepCount >= 3) {
      addEvent(sessionId, {
        type: "gaze.reading_pattern",
        severity: "strong",
        summary: `${gaze.sweepCount} line-reading sweeps while answering "${qa.question.slice(0, 50)}…"`,
        data: { qaId, ...gaze },
      });
    }
    if (gaze.offScreenRatio > 0.6) {
      addEvent(sessionId, {
        type: "gaze.offscreen_during_answer",
        severity: "medium",
        summary: `Gaze off-center ${(gaze.offScreenRatio * 100).toFixed(0)}% of the answer to "${qa.question.slice(0, 50)}…"`,
        data: { qaId, ...gaze },
      });
    }
  }

  // LLM similarity runs async so the candidate page isn't blocked on it.
  const clean = (transcript ?? "").trim();
  if (clean.length >= 12) {
    updateQA(sessionId, qaId, { similarityStatus: "pending" });
    scoreAnswerSimilarity(qa.question, clean)
      .then((r) => {
        updateQA(sessionId, qaId, {
          similarity: r?.similarity ?? null,
          similarityReasoning: r?.reasoning,
          similarityStatus: "scored",
        });
      })
      .catch((err) => {
        console.error("scoring failed:", err);
        updateQA(sessionId, qaId, { similarityStatus: "scored", similarity: null });
      });
  } else {
    console.warn(`answer ${qaId}: transcript too short to score (${clean.length} chars)`);
    updateQA(sessionId, qaId, { similarityStatus: "no_speech" });
  }

  return NextResponse.json({ ok: true });
}
