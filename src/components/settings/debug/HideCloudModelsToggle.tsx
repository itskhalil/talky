import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface HideCloudModelsToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const HideCloudModelsToggle: React.FC<HideCloudModelsToggleProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const hideCloudModels = getSetting("hide_cloud_models") ?? true;

  return (
    <ToggleSwitch
      checked={hideCloudModels}
      onChange={(enabled) => updateSetting("hide_cloud_models", enabled)}
      isUpdating={isUpdating("hide_cloud_models")}
      label={t("settings.debug.hideCloudModels.label")}
      description={t("settings.debug.hideCloudModels.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
