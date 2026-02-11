import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import { Maximize2 } from "lucide-react";
import { WaveformBars } from "@/components/ui/WaveformBars";
import "../App.css";

interface AmplitudeEvent {
  session_id: string;
  mic: number;
  speaker: number;
}

export function RecordingPill() {
  const [amplitude, setAmplitude] = useState({ mic: 0, speaker: 0 });
  const [iconSrc, setIconSrc] = useState<string | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Make the window background transparent
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";

    // Load the tray icon
    resolveResource("resources/tray_idle.png").then((path) => {
      setIconSrc(convertFileSrc(path));
    });
  }, []);

  useEffect(() => {
    // Listen directly to amplitude events - no filtering needed since
    // the pill only appears when recording is active
    const unlisten = listen<AmplitudeEvent>("session-amplitude", (event) => {
      setAmplitude({ mic: event.payload.mic, speaker: event.payload.speaker });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Use screen coordinates since the window moves during drag
    dragStartRef.current = { x: e.screenX, y: e.screenY };
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (dragStartRef.current) {
      const dx = Math.abs(e.screenX - dragStartRef.current.x);
      const dy = Math.abs(e.screenY - dragStartRef.current.y);
      // Only treat as click if mouse moved less than 5px
      if (dx < 5 && dy < 5) {
        invoke("show_main_from_pill");
      }
    }
    dragStartRef.current = null;
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      className="w-full h-full p-1.5 box-border cursor-pointer"
    >
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 py-2 bg-background-sidebar border border-border rounded-[24px] shadow-lg pointer-events-none">
        {iconSrc && (
          <img
            src={iconSrc}
            alt=""
            width={20}
            height={20}
            className="opacity-70"
          />
        )}
        <WaveformBars amplitude={amplitude} isRecording={true} />
        <Maximize2 size={12} className="text-text-secondary/50" />
      </div>
    </div>
  );
}
