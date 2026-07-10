import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Transcribes recorded answer audio via Groq's Whisper (free tier).
// Fallback path for when the browser's Web Speech API hears nothing.
export async function POST(req: NextRequest) {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ text: null, error: "no GROQ_API_KEY" });
  }

  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof File) || file.size < 1000) {
    return NextResponse.json({ text: null, error: "no usable audio" });
  }

  try {
    const gf = new FormData();
    gf.append("file", file, "answer.webm");
    gf.append("model", "whisper-large-v3-turbo");
    gf.append("language", "en");
    gf.append("response_format", "json");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: gf,
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("whisper transcription failed:", res.status, body.slice(0, 300));
      return NextResponse.json({ text: null, error: `groq ${res.status}` });
    }
    const data = await res.json();
    const text = (data.text ?? "").trim() || null;
    console.log(
      `transcribe: ${(file.size / 1024).toFixed(0)}KB audio -> ${text ? text.length + " chars" : "nothing heard"}`,
    );
    return NextResponse.json({ text });
  } catch (err) {
    console.error("whisper transcription error:", err);
    return NextResponse.json({ text: null, error: "transcription failed" });
  }
}
