import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface TranscriptClearingToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const TranscriptClearingToggle: React.FC<
  TranscriptClearingToggleProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const enabled = getSetting("transcript_clearing_enabled") ?? false;

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) => updateSetting("transcript_clearing_enabled", value)}
      isUpdating={isUpdating("transcript_clearing_enabled")}
      label={t("settings.debug.transcriptClearing.label")}
      description={t("settings.debug.transcriptClearing.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
