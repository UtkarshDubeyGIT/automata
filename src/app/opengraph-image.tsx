import { ImageResponse } from "next/og";

import { BRAND } from "@/config/brand";

export const alt = "Automata AI workflow automation for operators and developers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          overflow: "hidden",
          alignItems: "center",
          padding: "68px 78px",
          background: "#07070a",
          color: "#f4f4f7",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: 590,
            height: 590,
            right: -55,
            top: 20,
            border: "1px solid #292932",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: 390, height: 390, border: "1px solid #292932", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 190, height: 190, border: "1px solid #3c3c48", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", color: "#ffffff", fontSize: 25, fontWeight: 700 }}>
              {BRAND.name}
            </div>
          </div>
        </div>
        <div style={{ width: 760, display: "flex", flexDirection: "column", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 13, fontSize: 21, fontWeight: 700, letterSpacing: "-0.03em" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 22, borderRadius: 5, background: "#ffffff" }} />
              <span style={{ width: 8, height: 30, borderRadius: 5, background: "#b9b9c4" }} />
              <span style={{ width: 8, height: 18, borderRadius: 5, background: "#7b7b89" }} />
            </div>
            {BRAND.name}
          </div>
          <div style={{ marginTop: 53, color: "#a3a3ad", fontSize: 16, fontWeight: 600, letterSpacing: "0.14em" }}>
            AI WORKFLOW AUTOMATION
          </div>
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", fontSize: 57, fontWeight: 700, lineHeight: 1.05, letterSpacing: "-0.045em" }}>
            <div>Describe the outcome.</div>
            <div>Automata builds the work.</div>
          </div>
          <div style={{ marginTop: 24, color: "#a3a3ad", fontSize: 21, lineHeight: 1.4 }}>
            Connect your tools. Review consequential actions.
          </div>
          <div style={{ marginTop: 45, color: "#70707a", fontSize: 15 }}>
            automata.doubtbuddy.com
          </div>
        </div>
      </div>
    ),
    size,
  );
}
