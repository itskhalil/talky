import React from "react";
import { useTranslation } from "react-i18next";
import { Slider } from "../../ui/Slider";
import { useSettings } from "../../../hooks/useSettings";

interface MicEnergyThresholdProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const MicEnergyThreshold: React.FC<MicEnergyThresholdProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();

  const handleThresholdChange = (value: number) => {
    updateSetting("mic_energy_threshold", value);
  };

  return (
    <Slider
      value={settings?.mic_energy_threshold ?? 0.01}
      onChange={handleThresholdChange}
      min={0.001}
      max={0.1}
      step={0.001}
      label={t("settings.debug.micEnergyThreshold.title")}
      description={t("settings.debug.micEnergyThreshold.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      formatValue={(v) => v.toFixed(3)}
    />
  );
};
