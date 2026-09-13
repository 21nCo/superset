import { ImageResponse } from "next/og";

export const runtime = "edge";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(120deg, #0b1220, #0f172a)",
          color: "#e2e8f0",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 38,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "#38bdf8",
          }}
        >
          Superfunctions
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 88, fontWeight: 700, color: "#f8fafc" }}>DataFn Docs</div>
          <div style={{ fontSize: 34, color: "#cbd5e1" }}>
            Data processing and synchronization toolkit
          </div>
        </div>
      </div>
    ),
    size,
  );
}
