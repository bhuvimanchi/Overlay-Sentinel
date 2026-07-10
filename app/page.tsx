import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>🕵️ Overlay Sentinel</h1>
      <p className="muted">
        Zero-install detection of hidden AI interview copilots. The overlay is
        invisible to screen capture — the candidate&apos;s behavior is not.
      </p>
      <div className="grid2" style={{ marginTop: 24 }}>
        <div className="panel">
          <h2>Reviewer</h2>
          <p className="muted">
            Create a session per candidate with a fixed question set, send them
            the join link, and watch signals stream in live. Every completed
            session is stored as a per-candidate report.
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/reviewer">→ Manage sessions</Link>
          </p>
        </div>
        <div className="panel">
          <h2>Candidate</h2>
          <p className="muted">
            Open the join link from your interviewer (Chrome). Consent flow →
            webcam gaze analysis, environment scan, screen-share check — then
            answer the questions one by one.
          </p>
          <p style={{ marginTop: 12 }}>
            <Link href="/candidate">→ Join with a session code</Link>
          </p>
        </div>
      </div>
      <div className="panel">
        <h2>Demo flow</h2>
        <p className="muted">
          1. Create a session on the reviewer page (name + questions). 2. Copy
          the candidate link into another window or machine and complete setup.
          3. Questions appear one by one; the candidate answers out loud. 4.
          After the last answer the session auto-completes and the report is
          stored. Run one honest session and one with a copilot overlay, then
          compare the two reports side by side.
        </p>
      </div>
    </main>
  );
}
