import React from "react";
import { useTranslation } from "react-i18next";
import { CustomWords } from "../CustomWords";
import { FontSizeSetting } from "../FontSizeSetting";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { Alert } from "../../ui/Alert";
import ModelSelector from "../../model-selector";
import { UserNameSetting } from "./UserNameSetting";
import { EnvironmentsSection } from "../environments/EnvironmentsSection";
import { UpdateBanner } from "../../update-checker";
import { MeetingEndActionSetting } from "./MeetingEndActionSetting";
import { MeetingStartActionSetting } from "./MeetingStartActionSetting";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <UpdateBanner />
      <UserNameSetting />
      <SettingsGroup title={t("settings.appearance.title")}>
        <FontSizeSetting descriptionMode="tooltip" grouped />
      </SettingsGroup>
      <SettingsGroup title={t("modelSelector.chooseTranscriptionModel")}>
        <Alert variant="info" contained>
          {t("modelSelector.transcriptionTip")}
        </Alert>
        <ModelSelector />
        <CustomWords descriptionMode="tooltip" grouped />
      </SettingsGroup>
      <SettingsGroup title={t("settings.recording.title")}>
        <MeetingStartActionSetting />
        <MeetingEndActionSetting />
      </SettingsGroup>
      <EnvironmentsSection />
    </div>
  );
};
