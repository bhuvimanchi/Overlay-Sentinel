// Per-candidate session store. In-memory for live sessions, persisted to
// data/sessions/<id>.json on every mutation so completed interviews survive
// restarts and can be reviewed later.

import fs from "fs";
import path from "path";

export type Severity = "info" | "weak" | "medium" | "strong";

export interface SignalEvent {
  id: string;
  ts: number;
  type: string;
  severity: Severity;
  summary: string;
  data?: Record<string, unknown>;
}

export interface GazeSummary {
  offScreenRatio: number; // fraction of answer time gaze was off-center
  sweepCount: number; // line-reading sweeps detected during the answer
  samples: number;
}

export interface QA {
  id: string;
  question: string;
  askedAt: number;
  answeredAt?: number;
  latencyMs?: number; // question shown -> speech started
  transcript?: string;
  similarity?: number | null; // 0..1 vs LLM-generated answer, null = unavailable
  similarityReasoning?: string;
  similarityStatus?: "pending" | "scored" | "no_speech"; // drives the reviewer UI
  gaze?: GazeSummary;
}

export type SessionStatus = "pending" | "live" | "completed";

export interface Session {
  id: string;
  candidateName: string;
  status: SessionStatus;
  createdAt: number;
  completedAt?: number;
  candidateConnected: boolean;
  candidateFaceDetected: boolean;
  events: SignalEvent[];
  qas: QA[]; // one per planned question, created up-front
}

type Subscriber = (session: Session) => void;

interface Store {
  sessions: Map<string, Session>;
  subscribers: Map<string, Set<Subscriber>>;
  loaded: boolean;
}

const DATA_DIR = path.join(process.cwd(), "data", "sessions");

const g = globalThis as unknown as { __sentinelStore?: Store };
if (!g.__sentinelStore) {
  g.__sentinelStore = { sessions: new Map(), subscribers: new Map(), loaded: false };
}
const store = g.__sentinelStore;

function loadFromDisk(): void {
  if (store.loaded) return;
  store.loaded = true;
  try {
    if (!fs.existsSync(DATA_DIR)) return;
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) as Session;
        // A "live" session from before a restart has no connected candidate.
        if (s.status === "live") s.status = "pending";
        s.candidateConnected = false;
        s.candidateFaceDetected = false;
        store.sessions.set(s.id, s);
      } catch {
        /* skip corrupt file */
      }
    }
  } catch {
    /* no data dir yet */
  }
}

function persist(session: Session): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, `${session.id}.json`),
      JSON.stringify(session, null, 2),
    );
  } catch (err) {
    console.error("persist failed:", err);
  }
}

export function createSession(candidateName: string, questions: string[]): Session {
  loadFromDisk();
  const session: Session = {
    id: crypto.randomUUID().slice(0, 8), // short, link-friendly
    candidateName,
    status: "pending",
    createdAt: Date.now(),
    candidateConnected: false,
    candidateFaceDetected: false,
    events: [],
    qas: questions.map((q) => ({
      id: crypto.randomUUID(),
      question: q,
      askedAt: 0,
    })),
  };
  store.sessions.set(session.id, session);
  persist(session);
  return session;
}

export function getSession(id: string): Session | undefined {
  loadFromDisk();
  return store.sessions.get(id);
}

export function listSessions(): Session[] {
  loadFromDisk();
  return [...store.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function setCandidateConnected(id: string, connected: boolean): void {
  const s = getSession(id);
  if (!s) return;
  s.candidateConnected = connected;
  if (connected && s.status === "pending") s.status = "live";
  persist(s);
  broadcast(s);
}

export function setCandidateFace(id: string, detected: boolean): void {
  const s = getSession(id);
  if (!s || s.candidateFaceDetected === detected) return;
  s.candidateFaceDetected = detected;
  broadcast(s); // status only — not worth a disk write
}

export function addEvent(
  id: string,
  e: Omit<SignalEvent, "id" | "ts">,
): SignalEvent | undefined {
  const s = getSession(id);
  if (!s) return undefined;
  const event: SignalEvent = { ...e, id: crypto.randomUUID(), ts: Date.now() };
  s.events.push(event);
  persist(s);
  broadcast(s);
  return event;
}

export function updateQA(
  sessionId: string,
  qaId: string,
  patch: Partial<QA>,
): { session: Session; qa: QA } | undefined {
  const s = getSession(sessionId);
  if (!s) return undefined;
  const qa = s.qas.find((q) => q.id === qaId);
  if (!qa) return undefined;
  Object.assign(qa, patch);

  // Auto-complete: every planned question answered -> session ends and the
  // report is frozen to disk.
  if (s.status !== "completed" && s.qas.every((q) => q.answeredAt)) {
    s.status = "completed";
    s.completedAt = Date.now();
  }
  persist(s);
  broadcast(s);
  return { session: s, qa };
}

export function subscribe(sessionId: string, fn: Subscriber): () => void {
  const s = getSession(sessionId);
  let subs = store.subscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    store.subscribers.set(sessionId, subs);
  }
  subs.add(fn);
  if (s) fn(s); // immediate snapshot
  return () => {
    subs!.delete(fn);
  };
}

export function broadcast(session: Session): void {
  const subs = store.subscribers.get(session.id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(session);
    } catch {
      subs.delete(fn);
    }
  }
}
