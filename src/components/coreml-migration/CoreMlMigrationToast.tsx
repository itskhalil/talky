import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import {
  CORE_ML_MODEL_ID,
  CORE_ML_ULTRA_MODEL_ID,
  ONNX_ULTRA_MODEL_ID,
} from "@/lib/constants/modelIds";

// Background downloads that have no other progress UI: the v0.13 Core ML
// migration and an accepted Ultra upgrade.
const ULTRA_MODEL_IDS = [CORE_ML_ULTRA_MODEL_ID, ONNX_ULTRA_MODEL_ID];
const TRACKED_MODEL_IDS = [CORE_ML_MODEL_ID, ...ULTRA_MODEL_IDS];

interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percentage: number;
}

/// Persistent non-intrusive toast shown while the v0.12 → v0.13 upgrade
/// migration, or an accepted Ultra upgrade, downloads in the background.
/// Listens to the shared `model-download-progress` event and filters on
/// those model ids so it doesn't light up during unrelated downloads.
export const CoreMlMigrationToast: React.FC = () => {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<DownloadProgress | null>(null);

  useTauriEvent<DownloadProgress>("model-download-progress", (payload) => {
    if (!TRACKED_MODEL_IDS.includes(payload.model_id)) return;
    setProgress(payload);
    if (payload.percentage >= 100) {
      setTimeout(() => setProgress(null), 2000);
    }
  });

  useTauriEvent<{ model_id: string }>("model-download-complete", (payload) => {
    if (TRACKED_MODEL_IDS.includes(payload.model_id)) {
      setProgress(null);
    }
  });

  if (!progress) return null;

  const pct = Math.round(progress.percentage);

  return (
    <div className="fixed bottom-24 right-6 bg-background border border-mid-gray/20 rounded-xl shadow-lg px-4 py-3 flex items-center gap-3 min-w-[320px] max-w-[420px] z-40">
      <Download className="h-4 w-4 text-logo-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-text truncate">
          {ULTRA_MODEL_IDS.includes(progress.model_id)
            ? t("modelUpgrade.downloading", { percentage: pct })
            : t("coremlMigration.toast", { percentage: pct })}
        </p>
        <div className="w-full h-1 bg-mid-gray/20 rounded-full overflow-hidden mt-1.5">
          <div
            className="h-full bg-logo-primary rounded-full transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
};
