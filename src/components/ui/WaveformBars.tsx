import { useState, useEffect, useRef } from "react";

const TICK_MS = 180;

// Two sine frequencies per bar with irrational ratios — prevents repeating patterns
// so each bar drifts independently and their relative heights shift over time.
const BAR_FREQ: [number, number][] = [
  [0.31, 0.47],
  [0.37, 0.53],
  [0.43, 0.61],
];
const BASE = 0.7;
const SWING = 0.3; // multiplier oscillates in [BASE-SWING, BASE+SWING] = [0.4, 1.0]

interface WaveformBarsProps {
  amplitude: { mic: number; speaker: number };
  isRecording: boolean;
  size?: "sm" | "md";
}

export function WaveformBars({
  amplitude,
  isRecording,
  size = "md",
}: WaveformBarsProps) {
  const cy = size === "sm" ? 12 : 12;
  const barWidth = size === "sm" ? 3 : 3;
  const gap = size === "sm" ? 6.5 : 6.5;
  const svgWidth = size === "sm" ? 22 : 22;
  const svgHeight = size === "sm" ? 22 : 22;

  const [multipliers, setMultipliers] = useState<[number, number, number]>([
    0.7, 1.0, 0.5,
  ]);
  const tickRef = useRef(0);

  const amp = Math.max(amplitude.mic, amplitude.speaker) / 1000;
  const clamped = Math.min(Math.max(amp * 1.5, 0), 1);

  useEffect(() => {
    if (!isRecording) {
      setMultipliers([0.7, 1.0, 0.5]);
      tickRef.current = 0;
      return;
    }

    const id = setInterval(() => {
      tickRef.current += 1;
      const t = tickRef.current;
      setMultipliers(
        BAR_FREQ.map(([f1, f2]) => {
          const wave = (Math.sin(t * f1) + Math.sin(t * f2) * 0.6) / 1.6;
          return BASE + wave * SWING;
        }) as [number, number, number],
      );
    }, TICK_MS);

    return () => clearInterval(id);
  }, [isRecording]);

  if (isRecording) {
    const minH = 4;
    const maxH = 16;
    const h1 = minH + clamped * (maxH - minH) * multipliers[0];
    const h2 = minH + clamped * (maxH - minH) * multipliers[1];
    const h3 = minH + clamped * (maxH - minH) * multipliers[2];

    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox="0 0 24 24"
        className="text-green-500"
      >
        <rect
          x="4"
          y={cy - h1 / 2}
          width={barWidth}
          height={h1}
          rx="1.5"
          fill="currentColor"
          style={{ transition: "y 0.18s ease, height 0.18s ease" }}
        />
        <rect
          x={4 + gap}
          y={cy - h2 / 2}
          width={barWidth}
          height={h2}
          rx="1.5"
          fill="currentColor"
          style={{ transition: "y 0.18s ease, height 0.18s ease" }}
        />
        <rect
          x={4 + gap * 2}
          y={cy - h3 / 2}
          width={barWidth}
          height={h3}
          rx="1.5"
          fill="currentColor"
          style={{ transition: "y 0.18s ease, height 0.18s ease" }}
        />
      </svg>
    );
  }

  // Static bars when not recording
  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox="0 0 24 24"
      className="text-text-secondary/60"
    >
      <rect
        x="4"
        y={cy - 5}
        width={barWidth}
        height={10}
        rx="1.5"
        fill="currentColor"
      />
      <rect
        x={4 + gap}
        y={cy - 7}
        width={barWidth}
        height={14}
        rx="1.5"
        fill="currentColor"
      />
      <rect
        x={4 + gap * 2}
        y={cy - 4}
        width={barWidth}
        height={8}
        rx="1.5"
        fill="currentColor"
      />
    </svg>
  );
}
