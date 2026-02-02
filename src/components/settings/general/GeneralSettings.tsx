import React from "react";
import { useTranslation } from "react-i18next";
import { LanguageSelector } from "../LanguageSelector";
import { CustomWords } from "../CustomWords";
import { FontSizeSetting } from "../FontSizeSetting";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { useModelStore } from "../../../stores/modelStore";
import ModelSelector from "../../model-selector";
import { PostProcessingSettingsApi } from "../PostProcessingSettingsApi";
import { ChatSettings } from "../ChatSettings";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { currentModel, getModelInfo } = useModelStore();
  const currentModelInfo = getModelInfo(currentModel);
  const showLanguageSelector = currentModelInfo?.engine_type === "Whisper";
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.appearance.title")}>
        <FontSizeSetting descriptionMode="tooltip" grouped />
      </SettingsGroup>
      <SettingsGroup title={t("modelSelector.chooseTranscriptionModel")}>
        <ModelSelector />
        {showLanguageSelector && (
          <LanguageSelector descriptionMode="tooltip" grouped={true} />
        )}
        <CustomWords descriptionMode="tooltip" grouped />
      </SettingsGroup>
      <SettingsGroup title={t("modelSelector.summarisationModel")}>
        <PostProcessingSettingsApi />
      </SettingsGroup>
      <SettingsGroup title={t("settings.chat.title")}>
        <ChatSettings />
      </SettingsGroup>
    </div>
  );
};
