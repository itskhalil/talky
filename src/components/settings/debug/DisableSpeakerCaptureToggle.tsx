import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface DisableSpeakerCaptureToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const DisableSpeakerCaptureToggle: React.FC<
  DisableSpeakerCaptureToggleProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const disabled = getSetting("debug_disable_speaker_capture") ?? false;

  return (
    <ToggleSwitch
      checked={disabled}
      onChange={(enabled) =>
        updateSetting("debug_disable_speaker_capture", enabled)
      }
      isUpdating={isUpdating("debug_disable_speaker_capture")}
      label={t("settings.debug.disableSpeakerCapture.label")}
      description={t("settings.debug.disableSpeakerCapture.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
