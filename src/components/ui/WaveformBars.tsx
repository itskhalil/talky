import { useState, useEffect, useRef } from "react";

const TICK_MS = 100;

// Two sine frequencies per bar with irrational ratios — prevents repeating patterns.
// Phase offsets (~120° apart) ensure neighbouring bars are always at different heights.
const BAR_FREQ: [number, number, number][] = [
  [0.31, 0.47, 0],
  [0.37, 0.53, 2.09],
  [0.43, 0.61, 4.19],
];
const BASE = 0.7;
const SWING = 0.3; // multiplier oscillates in [BASE-SWING, BASE+SWING] = [0.4, 1.0]

// Static bar heights (not recording)
const STATIC_HEIGHTS = [10, 14, 8];

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
  const cy = 12;
  const barWidth = 3;
  const gap = 6.5;
  const svgWidth = 22;
  const svgHeight = 22;
  const startX = 4;

  const [multipliers, setMultipliers] = useState<number[]>(
    () => STATIC_HEIGHTS.map((h) => h / 16), // normalise to ~multiplier scale
  );
  const tickRef = useRef(0);

  const amp = Math.max(amplitude.mic, amplitude.speaker) / 1000;
  const clamped = Math.min(Math.max(amp * 1.5, 0), 1);

  useEffect(() => {
    if (!isRecording) {
      setMultipliers(STATIC_HEIGHTS.map((h) => h / 16));
      tickRef.current = 0;
      return;
    }

    const id = setInterval(() => {
      tickRef.current += 1;
      const t = tickRef.current;
      setMultipliers(
        BAR_FREQ.map(([f1, f2, phase]) => {
          const wave =
            (Math.sin(t * f1 + phase) + Math.sin(t * f2 + phase) * 0.6) / 1.6;
          return BASE + wave * SWING;
        }),
      );
    }, TICK_MS);

    return () => clearInterval(id);
  }, [isRecording]);

  const minH = 4;
  const maxH = 16;

  if (isRecording) {
    return (
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox="0 0 24 24"
        className="text-green-500"
      >
        {multipliers.map((m, i) => {
          const h = minH + clamped * (maxH - minH) * m;
          return (
            <rect
              key={i}
              x={startX + i * gap}
              y={cy - h / 2}
              width={barWidth}
              height={h}
              rx="1.5"
              fill="currentColor"
              style={{ transition: "y 0.1s ease, height 0.1s ease" }}
            />
          );
        })}
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
      {STATIC_HEIGHTS.map((h, i) => (
        <rect
          key={i}
          x={startX + i * gap}
          y={cy - h / 2}
          width={barWidth}
          height={h}
          rx="1.5"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}
