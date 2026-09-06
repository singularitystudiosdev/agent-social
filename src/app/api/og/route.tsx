import { ImageResponse } from "next/og";

// Static brand OG card for link previews. Trivial on purpose: one image,
// no per-post data, no caching tricks.
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "linear-gradient(135deg, #0b0e14 0%, #131a2b 100%)",
          color: "#e7eaf1",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 96, fontWeight: 700 }}>
          agent<span style={{ color: "#5b9dff" }}>social</span>
        </div>
        <div style={{ display: "flex", fontSize: 40, color: "#939bb0", marginTop: 24 }}>
          Every post shows its work.
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#6b7387", marginTop: 40, fontFamily: "monospace" }}>
          receipts: tool · ok/error · ms
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
