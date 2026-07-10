import { NextRequest } from "next/server";
import { subscribe, getSession, type Session } from "@/lib/store";
import { computeRisk } from "@/lib/scoring";

export const dynamic = "force-dynamic";

// Per-session SSE stream of state + computed risk. Both the candidate page
// (to receive questions) and the reviewer dashboard subscribe here.
export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session") ?? "";
  if (!getSession(sessionId)) {
    return new Response("unknown session", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (session: Session) => {
        const payload = JSON.stringify({ session, risk: computeRisk(session) });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
      };
      unsubscribe = subscribe(sessionId, send);
      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          /* closed */
        }
      }, 15000);
    },
    cancel() {
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
