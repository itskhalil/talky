import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownCircle } from "lucide-react";
import { useUpdateChecker } from "./UpdateChecker";
import { ProgressBar } from "../shared";

export const UpdateBanner: React.FC = () => {
  const { t } = useTranslation();
  const {
    updateAvailable,
    isInstalling,
    downloadProgress,
    updateChecksEnabled,
    installUpdate,
  } = useUpdateChecker();

  if (!updateChecksEnabled || !updateAvailable) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-logo-primary/10 px-4 py-3">
      <div className="flex items-center gap-3">
        <ArrowDownCircle className="h-5 w-5 text-logo-primary" />
        <span className="text-sm font-medium text-logo-primary">
          {t("settings.general.updateBanner.message")}
        </span>
      </div>
      <div className="flex items-center gap-3">
        {isInstalling && downloadProgress > 0 && downloadProgress < 100 && (
          <ProgressBar
            progress={[
              {
                id: "update-banner",
                percentage: downloadProgress,
              },
            ]}
            size="large"
          />
        )}
        <button
          onClick={installUpdate}
          disabled={isInstalling}
          className="rounded-md bg-logo-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-logo-primary/90 disabled:opacity-50"
        >
          {isInstalling
            ? downloadProgress === 100
              ? t("footer.installing")
              : t("footer.downloading", {
                  progress: downloadProgress.toString().padStart(3),
                })
            : t("settings.general.updateBanner.install")}
        </button>
      </div>
    </div>
  );
};
