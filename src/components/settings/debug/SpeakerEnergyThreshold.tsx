import React from "react";
import { useTranslation } from "react-i18next";
import { Slider } from "../../ui/Slider";
import { useSettings } from "../../../hooks/useSettings";

interface SpeakerEnergyThresholdProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const SpeakerEnergyThreshold: React.FC<SpeakerEnergyThresholdProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();

  const handleThresholdChange = (value: number) => {
    updateSetting("speaker_energy_threshold", value);
  };

  return (
    <Slider
      value={settings?.speaker_energy_threshold ?? 0.02}
      onChange={handleThresholdChange}
      min={0.001}
      max={0.1}
      step={0.001}
      label={t("settings.debug.speakerEnergyThreshold.title")}
      description={t("settings.debug.speakerEnergyThreshold.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      formatValue={(v) => v.toFixed(3)}
    />
  );
};
