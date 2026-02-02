import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";
import type { FontSize } from "@/bindings";

interface FontSizeSettingProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const FONT_SIZE_OPTIONS: { value: FontSize; labelKey: string }[] = [
  { value: "small", labelKey: "settings.appearance.fontSize.small" },
  { value: "medium", labelKey: "settings.appearance.fontSize.medium" },
  { value: "large", labelKey: "settings.appearance.fontSize.large" },
];

export const FontSizeSetting: React.FC<FontSizeSettingProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const currentFontSize = getSetting("font_size") ?? "medium";

    const options = FONT_SIZE_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    }));

    const handleChange = (value: string) => {
      updateSetting("font_size", value as FontSize);
    };

    return (
      <SettingContainer
        title={t("settings.appearance.fontSize.title")}
        description={t("settings.appearance.fontSize.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <Dropdown
          options={options}
          selectedValue={currentFontSize}
          onSelect={handleChange}
          disabled={isUpdating("font_size")}
        />
      </SettingContainer>
    );
  },
);

FontSizeSetting.displayName = "FontSizeSetting";
