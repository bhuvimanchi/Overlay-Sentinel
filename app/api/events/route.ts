import { NextRequest, NextResponse } from "next/server";
import { addEvent, setCandidateConnected, setCandidateFace, getSession } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const sessionId = String(body.sessionId ?? "");
  if (!getSession(sessionId)) {
    return NextResponse.json({ error: "unknown session" }, { status: 404 });
  }

  if (body.type === "candidate.connected") {
    setCandidateConnected(sessionId, true);
    return NextResponse.json({ ok: true });
  }
  // Live gaze-pipeline health — status only, kept out of the signal timeline.
  if (body.type === "candidate.face") {
    setCandidateFace(sessionId, Boolean(body.detected));
    return NextResponse.json({ ok: true });
  }

  const event = addEvent(sessionId, {
    type: String(body.type ?? "unknown"),
    severity: body.severity ?? "info",
    summary: String(body.summary ?? ""),
    data: body.data,
  });
  return NextResponse.json({ ok: true, id: event?.id });
}
