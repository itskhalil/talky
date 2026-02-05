import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface SkipMicOnSpeakerEnergyToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const SkipMicOnSpeakerEnergyToggle: React.FC<SkipMicOnSpeakerEnergyToggleProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const skipMicOnSpeakerEnergy = getSetting("skip_mic_on_speaker_energy") ?? true;

  return (
    <ToggleSwitch
      checked={skipMicOnSpeakerEnergy}
      onChange={(enabled) => updateSetting("skip_mic_on_speaker_energy", enabled)}
      isUpdating={isUpdating("skip_mic_on_speaker_energy")}
      label={t("settings.debug.skipMicOnSpeakerEnergy.label")}
      description={t("settings.debug.skipMicOnSpeakerEnergy.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
