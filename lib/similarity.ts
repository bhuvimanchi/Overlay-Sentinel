export interface SimilarityResult {
  similarity: number; // 0..1
  reasoning: string;
  source: "groq" | "anthropic" | "heuristic";
}

// Scores how closely a candidate's spoken answer resembles an AI copilot's
// generated answer read aloud. Provider order (first available wins):
//   1. Groq   — free hosted LLM (set GROQ_API_KEY), best judgment, no card needed
//   2. Claude — if you happen to have ANTHROPIC_API_KEY set
//   3. Local heuristic — always available, offline, no key
// Never returns null: the signal always produces a score.
export async function scoreAnswerSimilarity(
  question: string,
  transcript: string,
): Promise<SimilarityResult | null> {
  if (!transcript.trim()) return null;

  if (process.env.GROQ_API_KEY) {
    const r = await scoreViaGroq(question, transcript).catch(() => null);
    if (r) return r;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await scoreViaAnthropic(question, transcript).catch(() => null);
    if (r) return r;
  }
  return scoreViaHeuristic(transcript);
}

const PROMPT = (question: string, transcript: string) =>
  `You are a signal in an interview-integrity system. AI "interview copilots" listen to the interviewer's question and feed the candidate a generated answer on a hidden overlay, which the candidate reads aloud.

First, consider what a typical LLM assistant would answer to this question. Then judge how strongly the candidate's transcribed spoken answer resembles such a generated answer read aloud, versus spontaneous human speech.

Indicators of a read LLM answer: comprehensive enumerated structure ("first... second... third..."), textbook-complete coverage, written-register phrasing, no self-corrections or personal anecdotes, hedged both-sides framing. Indicators of spontaneous speech: false starts, personal specifics, uneven depth, colloquial phrasing, tangents.

The transcript is from speech recognition, so punctuation is unreliable — judge structure and content, not punctuation.

INTERVIEWER QUESTION:
${question}

CANDIDATE ANSWER (speech-to-text transcript):
${transcript}

Reply with ONLY a JSON object, no other text:
{"similarity": <number 0 to 1>, "reasoning": "<one or two sentences citing the strongest indicators>"}`;

function extractJson(text: string): { similarity: number; reasoning: string } | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return {
      similarity: Math.max(0, Math.min(1, Number(parsed.similarity) || 0)),
      reasoning: String(parsed.reasoning ?? ""),
    };
  } catch {
    return null;
  }
}

// --- Provider 1: Groq (free, OpenAI-compatible) ---------------------------
async function scoreViaGroq(
  question: string,
  transcript: string,
): Promise<SimilarityResult | null> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      max_tokens: 400,
      temperature: 0,
      messages: [{ role: "user", content: PROMPT(question, transcript) }],
    }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(text);
  return parsed ? { ...parsed, source: "groq" } : null;
}

// --- Provider 2: Anthropic (only if a key is present) ---------------------
async function scoreViaAnthropic(
  question: string,
  transcript: string,
): Promise<SimilarityResult | null> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    messages: [{ role: "user", content: PROMPT(question, transcript) }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  const parsed = extractJson(block.text);
  return parsed ? { ...parsed, source: "anthropic" } : null;
}

// --- Provider 3: Local heuristic (always available, offline) ---------------
// Scores the linguistic signature of a read LLM answer vs. spontaneous speech.
// Not as nuanced as an LLM, but free, instant, and defensible for a demo.
function scoreViaHeuristic(transcript: string): SimilarityResult {
  const t = ` ${transcript.toLowerCase()} `;
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const count = (patterns: RegExp[]) =>
    patterns.reduce((n, re) => n + (t.match(re)?.length ?? 0), 0);

  // Signals of a read, generated answer (push similarity up)
  const structure = count([
    /\bfirst(ly)?\b/g,
    /\bsecond(ly)?\b/g,
    /\bthird(ly)?\b/g,
    /\bfinally\b/g,
    /\bnext\b/g,
    /\badditionally\b/g,
    /\bfurthermore\b/g,
    /\bmoreover\b/g,
    /\bin conclusion\b/g,
    /\bto summarize\b/g,
  ]);
  const connectors = count([
    /\bhowever\b/g,
    /\btherefore\b/g,
    /\bthus\b/g,
    /\bconsequently\b/g,
    /\bin contrast\b/g,
    /\bon the other hand\b/g,
    /\bfor example\b/g,
    /\bsuch as\b/g,
  ]);

  // Signals of spontaneous human speech (push similarity down)
  const disfluency = count([
    /\bum+\b/g,
    /\buh+\b/g,
    /\ber+\b/g,
    /\bhmm+\b/g,
    /\blike\b/g,
    /\byou know\b/g,
    /\bi mean\b/g,
    /\bsort of\b/g,
    /\bkind of\b/g,
    /\bkinda\b/g,
    /\bbasically\b/g,
    /\bi guess\b/g,
    /\bactually\b/g,
    /\bwait\b/g,
  ]);
  const personal = count([
    /\bi remember\b/g,
    /\bone time\b/g,
    /\bat my (last )?(job|company|internship)\b/g,
    /\bwe had\b/g,
    /\bin my experience\b/g,
    /\bi once\b/g,
  ]);

  // Density per 100 words so length doesn't dominate
  const per100 = (n: number) => (wordCount > 0 ? (n / wordCount) * 100 : 0);

  let score = 0.45;
  score += Math.min(0.38, per100(structure) * 0.14);
  score += Math.min(0.17, per100(connectors) * 0.05);
  score -= Math.min(0.4, per100(disfluency) * 0.1);
  score -= Math.min(0.25, per100(personal) * 0.15);
  // Very short answers are hard to judge — pull toward the middle
  if (wordCount < 15) score = 0.4 + (score - 0.4) * 0.5;
  score = Math.max(0, Math.min(1, score));

  const parts: string[] = [];
  if (structure) parts.push(`${structure} enumeration marker(s)`);
  if (connectors) parts.push(`${connectors} formal connector(s)`);
  if (disfluency) parts.push(`${disfluency} disfluency/filler`);
  if (personal) parts.push(`${personal} personal-anecdote cue(s)`);
  const reasoning = parts.length
    ? `Local heuristic — ${parts.join(", ")} across ${wordCount} words.`
    : `Local heuristic — neutral phrasing across ${wordCount} words.`;

  return { similarity: score, reasoning, source: "heuristic" };
}
