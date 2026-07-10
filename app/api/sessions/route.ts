import { NextRequest, NextResponse } from "next/server";
import { createSession, listSessions } from "@/lib/store";
import { computeRisk } from "@/lib/scoring";

export const dynamic = "force-dynamic";

// Create a session: candidate name + the planned question list.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = String(body.candidateName ?? "").trim();
  const questions = (Array.isArray(body.questions) ? body.questions : [])
    .map((q: unknown) => String(q).trim())
    .filter(Boolean);
  if (!name) return NextResponse.json({ error: "candidateName required" }, { status: 400 });
  if (questions.length === 0)
    return NextResponse.json({ error: "at least one question required" }, { status: 400 });

  const session = createSession(name, questions);
  return NextResponse.json({ ok: true, id: session.id });
}

// List all sessions (summaries) for the reviewer's manager view.
export async function GET() {
  const sessions = listSessions().map((s) => {
    const risk = computeRisk(s);
    return {
      id: s.id,
      candidateName: s.candidateName,
      status: s.status,
      createdAt: s.createdAt,
      completedAt: s.completedAt,
      answered: s.qas.filter((q) => q.answeredAt).length,
      total: s.qas.length,
      score: risk.score,
      band: risk.band,
    };
  });
  return NextResponse.json({ sessions });
}
