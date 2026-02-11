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

  if (isRecording) {
    const amp = Math.max(amplitude.mic, amplitude.speaker) / 1000;
    const clamped = Math.min(Math.max(amp * 1.5, 0), 1);
    const minH = 4;
    const maxH = 16;
    const h1 = minH + clamped * (maxH - minH) * 0.7;
    const h2 = minH + clamped * (maxH - minH);
    const h3 = minH + clamped * (maxH - minH) * 0.5;

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
          style={{ transition: "y 0.1s ease, height 0.1s ease" }}
        />
        <rect
          x={4 + gap}
          y={cy - h2 / 2}
          width={barWidth}
          height={h2}
          rx="1.5"
          fill="currentColor"
          style={{ transition: "y 0.1s ease, height 0.1s ease" }}
        />
        <rect
          x={4 + gap * 2}
          y={cy - h3 / 2}
          width={barWidth}
          height={h3}
          rx="1.5"
          fill="currentColor"
          style={{ transition: "y 0.1s ease, height 0.1s ease" }}
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
