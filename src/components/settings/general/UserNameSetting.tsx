import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SettingContainer } from "../../ui/SettingContainer";
import { useSettings } from "@/hooks/useSettings";

interface UserNameSettingProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const UserNameSetting: React.FC<UserNameSettingProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting } = useSettings();

    const storedName = getSetting("user_name") ?? "";
    const [value, setValue] = useState(storedName);

    useEffect(() => {
      setValue(getSetting("user_name") ?? "");
    }, [storedName]);

    const handleBlur = () => {
      const trimmed = value.trim();
      if (trimmed !== storedName) {
        updateSetting("user_name", trimmed);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      }
    };

    return (
      <SettingContainer
        title={t("settings.userName.title")}
        description={t("settings.userName.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={t("settings.userName.placeholder")}
          className="w-40 px-2.5 py-1.5 text-sm rounded-md border border-mid-gray/20 bg-transparent outline-none focus:border-accent transition-colors"
        />
      </SettingContainer>
    );
  },
);

UserNameSetting.displayName = "UserNameSetting";
