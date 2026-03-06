import React from "react";
import { useTranslation } from "react-i18next";
import { WordCorrectionThreshold } from "./WordCorrectionThreshold";
import { SpeakerEnergyThreshold } from "./SpeakerEnergyThreshold";
import { SkipMicOnSpeakerEnergyToggle } from "./SkipMicOnSpeakerEnergyToggle";
import { LogLevelSelector } from "./LogLevelSelector";
import { CopyAsBulletsToggle } from "./CopyAsBulletsToggle";
import { SaveDebugRecordingsToggle } from "./SaveDebugRecordingsToggle";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { UpdateChecksToggle } from "../UpdateChecksToggle";
import { AppDataDirectory } from "../AppDataDirectory";

export const DebugSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.debug.title")}>
        <LogLevelSelector grouped={true} />
        <UpdateChecksToggle descriptionMode="tooltip" grouped={true} />
        <CopyAsBulletsToggle descriptionMode="tooltip" grouped={true} />
        <WordCorrectionThreshold descriptionMode="tooltip" grouped={true} />
        <SpeakerEnergyThreshold descriptionMode="tooltip" grouped={true} />
        <SkipMicOnSpeakerEnergyToggle
          descriptionMode="tooltip"
          grouped={true}
        />
        <SaveDebugRecordingsToggle descriptionMode="tooltip" grouped={true} />
        <AppDataDirectory descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>
    </div>
  );
};
