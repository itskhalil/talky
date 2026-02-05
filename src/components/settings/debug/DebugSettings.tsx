import React from "react";
import { useTranslation } from "react-i18next";
import { WordCorrectionThreshold } from "./WordCorrectionThreshold";
import { SpeakerEnergyThreshold } from "./SpeakerEnergyThreshold";
import { LogLevelSelector } from "./LogLevelSelector";
import { HideCloudModelsToggle } from "./HideCloudModelsToggle";
import { CopyAsBulletsToggle } from "./CopyAsBulletsToggle";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { ClamshellMicrophoneSelector } from "../ClamshellMicrophoneSelector";
import { UpdateChecksToggle } from "../UpdateChecksToggle";

export const DebugSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.debug.title")}>
        <LogLevelSelector grouped={true} />
        <UpdateChecksToggle descriptionMode="tooltip" grouped={true} />
        <HideCloudModelsToggle descriptionMode="tooltip" grouped={true} />
        <CopyAsBulletsToggle descriptionMode="tooltip" grouped={true} />
        <WordCorrectionThreshold descriptionMode="tooltip" grouped={true} />
        <SpeakerEnergyThreshold descriptionMode="tooltip" grouped={true} />
        <ClamshellMicrophoneSelector descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
