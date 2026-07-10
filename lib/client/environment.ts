"use client";

// Consent-based environment scan using only what a normal web page can see.
// Individually weak signals — they only matter stacked with behavioral ones.

export interface EnvFlag {
  type: string;
  severity: "weak" | "medium";
  summary: string;
}

const VIRTUAL_AUDIO = /virtual|vb-audio|vb cable|cable (in|out)|blackhole|voicemeeter|soundflower|loopback/i;

export async function runEnvironmentScan(): Promise<EnvFlag[]> {
  const flags: EnvFlag[] = [];

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const virtual = devices.filter(
      (d) => d.kind.startsWith("audio") && VIRTUAL_AUDIO.test(d.label),
    );
    if (virtual.length > 0) {
      flags.push({
        type: "env.virtual_audio_device",
        severity: "medium",
        summary: `Virtual audio device(s): ${[...new Set(virtual.map((d) => d.label))].join(", ")} — copilots use these to capture interviewer audio`,
      });
    }
  } catch {
    /* permission denied — nothing to report */
  }

  // Multi-screen via the Window Management API / isExtended (Chrome)
  try {
    const isExtended = (screen as any).isExtended;
    if (isExtended === true) {
      flags.push({
        type: "env.multi_screen",
        severity: "weak",
        summary:
          "Display is extended across multiple screens (weak signal — many honest candidates have second monitors)",
      });
    }
  } catch {
    /* unsupported */
  }

  return flags;
}

// Requests a full-monitor share. The overlay itself is invisible in the
// capture (that's the point of stealth mode) — what we get is (a) enforcement
// pressure, (b) a flag if the candidate shares a window/tab instead of the
// monitor, and (c) a flag if the share is killed mid-interview.
export async function requestMonitorShare(
  onFlag: (f: EnvFlag) => void,
): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "monitor" } as MediaTrackConstraints,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const surface = (track.getSettings() as any).displaySurface;
    if (surface && surface !== "monitor") {
      onFlag({
        type: "screen.not_full_monitor",
        severity: "medium",
        summary: `Candidate shared a ${surface} instead of the full monitor`,
      });
    }
    track.addEventListener("ended", () => {
      onFlag({
        type: "screen.share_ended",
        severity: "medium",
        summary: "Candidate stopped the screen share during the interview",
      });
    });
    return stream;
  } catch {
    onFlag({
      type: "screen.not_full_monitor",
      severity: "medium",
      summary: "Candidate declined screen sharing",
    });
    return null;
  }
}

export async function postEvent(
  sessionId: string,
  flag: {
    type: string;
    severity: string;
    summary: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...flag }),
  });
}
