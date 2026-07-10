"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@/lib/store";
import type { RiskReport } from "@/lib/scoring";

export default function SessionDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [session, setSession] = useState<Session | null>(null);
  const [risk, setRisk] = useState<RiskReport | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const es = new EventSource(`/api/stream?session=${id}`);
    es.onmessage = (ev) => {
      const parsed = JSON.parse(ev.data);
      setSession(parsed.session);
      setRisk(parsed.risk);
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setNotFound(true);
    };
    return () => es.close();
  }, [id]);

  const exportReport = () => {
    const blob = new Blob(
      [JSON.stringify({ generatedAt: new Date().toISOString(), risk, session }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `report-${session?.candidateName?.replace(/\s+/g, "-") ?? "session"}-${id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (notFound) {
    return (
      <main>
        <h1>Session not found</h1>
        <p>
          <Link href="/reviewer">← back to sessions</Link>
        </p>
      </main>
    );
  }

  const bandColor =
    risk?.band === "high-risk"
      ? "var(--red)"
      : risk?.band === "suspicious"
        ? "var(--amber)"
        : "var(--green)";

  const answered = session?.qas.filter((q) => q.answeredAt).length ?? 0;
  const total = session?.qas.length ?? 0;
  const current = session?.qas.find((q) => !q.answeredAt);

  return (
    <main>
      <p style={{ marginBottom: 8 }}>
        <Link href="/reviewer">← all sessions</Link>
      </p>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>{session?.candidateName ?? "…"}</h1>
        <button className="secondary" onClick={exportReport}>
          Export report
        </button>
      </div>

      <p
        className="muted"
        style={{ marginBottom: 20, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}
      >
        <span className={`badge ${session?.status === "completed" ? "info" : session?.status === "live" ? "clean" : "weak"}`}>
          {session?.status ?? "…"}
        </span>
        <span>
          Progress: {answered}/{total}
          {session?.status === "completed" && " — session complete"}
        </span>
        {session?.status !== "completed" && (
          <span>
            Candidate:{" "}
            {session?.candidateConnected ? (
              <span style={{ color: "var(--green)" }}>connected</span>
            ) : (
              <span>not connected</span>
            )}
          </span>
        )}
        {session?.candidateConnected && session.status !== "completed" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: session.candidateFaceDetected ? "var(--green)" : "var(--amber)",
              }}
            />
            <span style={{ color: session.candidateFaceDetected ? "var(--green)" : "var(--amber)" }}>
              gaze pipeline: {session.candidateFaceDetected ? "face detected" : "no face"}
            </span>
          </span>
        )}
      </p>

      {current && session?.status === "live" && (
        <div className="panel">
          <p className="muted">Current question ({answered + 1} of {total}):</p>
          <strong>{current.question}</strong>
        </div>
      )}

      <div className="panel">
        <h2>Risk score</h2>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
          <span className="score-ring" style={{ color: bandColor }}>
            {risk?.score ?? 0}
          </span>
          <span className={`badge ${risk?.band ?? "clean"}`}>{risk?.band ?? "clean"}</span>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          Advisory signal for a human reviewer — never an automatic verdict.
        </p>
        <div style={{ marginTop: 16 }}>
          {risk && risk.contributions.length === 0 && <p className="muted">No signals.</p>}
          {risk?.contributions.map((c, i) => (
            <div key={i} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <strong>{c.label}</strong>
                <span style={{ color: bandColor }}>+{c.points}</span>
              </div>
              <span className="muted">{c.evidence}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Per-question evidence</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Question</th>
              <th>Latency</th>
              <th>Reading sweeps</th>
              <th>Off-cam</th>
              <th>LLM match</th>
              <th>Heard (transcript)</th>
            </tr>
          </thead>
          <tbody>
            {(session?.qas ?? []).map((qa, i) => (
              <tr key={qa.id}>
                <td className="muted">{i + 1}</td>
                <td>{qa.question}</td>
                <td>{qa.latencyMs != null ? `${(qa.latencyMs / 1000).toFixed(1)}s` : "—"}</td>
                <td>{qa.gaze ? qa.gaze.sweepCount : "—"}</td>
                <td>{qa.gaze ? `${(qa.gaze.offScreenRatio * 100).toFixed(0)}%` : "—"}</td>
                <td>
                  {!qa.answeredAt ? (
                    "—"
                  ) : qa.similarityStatus === "no_speech" ? (
                    <span className="muted" title="No speech was captured for this answer">
                      no speech
                    </span>
                  ) : qa.similarity == null ? (
                    <span className="muted">scoring…</span>
                  ) : (
                    <span
                      title={qa.similarityReasoning}
                      style={{ color: qa.similarity >= 0.75 ? "var(--red)" : "var(--muted)" }}
                    >
                      {(qa.similarity * 100).toFixed(0)}%
                    </span>
                  )}
                </td>
                <td className="muted" style={{ maxWidth: 260, fontSize: "0.78rem" }} title={qa.transcript || ""}>
                  {qa.answeredAt
                    ? qa.transcript?.trim()
                      ? qa.transcript.length > 90
                        ? qa.transcript.slice(0, 90) + "…"
                        : qa.transcript
                      : "⚠ nothing heard"
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Signal timeline</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Signal</th>
              <th>Severity</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {[...(session?.events ?? [])].reverse().map((e) => (
              <tr key={e.id}>
                <td className="muted">{new Date(e.ts).toLocaleTimeString()}</td>
                <td>{e.type}</td>
                <td>
                  <span className={`badge ${e.severity}`}>{e.severity}</span>
                </td>
                <td>{e.summary}</td>
              </tr>
            ))}
            {(session?.events ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No signals.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
