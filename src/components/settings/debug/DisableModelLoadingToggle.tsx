import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "../../../hooks/useSettings";

interface DisableModelLoadingToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const DisableModelLoadingToggle: React.FC<
  DisableModelLoadingToggleProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const disabled = getSetting("debug_disable_model_loading") ?? false;

  return (
    <ToggleSwitch
      checked={disabled}
      onChange={(enabled) =>
        updateSetting("debug_disable_model_loading", enabled)
      }
      isUpdating={isUpdating("debug_disable_model_loading")}
      label={t("settings.debug.disableModelLoading.label")}
      description={t("settings.debug.disableModelLoading.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
    />
  );
};
