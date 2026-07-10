"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SessionSummary {
  id: string;
  candidateName: string;
  status: "pending" | "live" | "completed";
  createdAt: number;
  completedAt?: number;
  answered: number;
  total: number;
  score: number;
  band: "clean" | "suspicious" | "high-risk";
}

const DEFAULT_QUESTIONS = `Walk me through how you'd design a URL shortener.
What's the difference between a process and a thread?
Tell me about a bug you found that took a long time to fix.`;

export default function ReviewerHome() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [name, setName] = useState("");
  const [questions, setQuestions] = useState(DEFAULT_QUESTIONS);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    setSessions(data.sessions ?? []);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000); // keep statuses/scores fresh
    return () => clearInterval(t);
  }, [refresh]);

  const create = async () => {
    const qs = questions
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
    if (!name.trim() || qs.length === 0) return;
    setCreating(true);
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateName: name.trim(), questions: qs }),
    });
    setName("");
    setCreating(false);
    refresh();
  };

  const copyLink = (id: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/candidate?s=${id}`);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <main>
      <h1>Interview sessions</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        One session per candidate. Set the questions up-front; the candidate
        answers them one by one and the session completes automatically. Every
        report is stored per candidate.
      </p>

      <div className="panel">
        <h2>New session</h2>
        <div style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="Candidate name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <label className="muted" style={{ fontSize: "0.82rem" }}>
          Questions — one per line, asked in order:
        </label>
        <textarea
          rows={5}
          value={questions}
          onChange={(e) => setQuestions(e.target.value)}
          style={{ margin: "6px 0 12px" }}
        />
        <button onClick={create} disabled={creating || !name.trim()}>
          Create session
        </button>
      </div>

      <div className="panel">
        <h2>Sessions</h2>
        <table>
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Risk</th>
              <th>Created</th>
              <th>Candidate link</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.candidateName}</td>
                <td>
                  <span
                    className={`badge ${
                      s.status === "completed"
                        ? "info"
                        : s.status === "live"
                          ? "clean"
                          : "weak"
                    }`}
                  >
                    {s.status}
                  </span>
                </td>
                <td>
                  {s.answered}/{s.total}
                </td>
                <td>
                  <span className={`badge ${s.band}`}>
                    {s.score} · {s.band}
                  </span>
                </td>
                <td className="muted">
                  {new Date(s.createdAt).toLocaleString()}
                </td>
                <td>
                  <button
                    className="secondary"
                    style={{ fontSize: "0.78rem", padding: "4px 10px" }}
                    onClick={() => copyLink(s.id)}
                  >
                    {copied === s.id ? "✓ copied" : "copy link"}
                  </button>
                </td>
                <td>
                  <Link href={`/reviewer/${s.id}`}>open →</Link>
                </td>
              </tr>
            ))}
            {sessions.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No sessions yet — create one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
