import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  DebugSettings,
  KeyboardShortcutsSettings,
  AboutSettings,
} from "./settings";

type SettingsTab = "general" | "debug" | "keyboard" | "about";

interface SettingsPageProps {
  onBack: () => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

  const tabs: { id: SettingsTab; labelKey: string; enabled: boolean }[] = [
    { id: "general", labelKey: "sidebar.general", enabled: true },
    {
      id: "debug",
      labelKey: "sidebar.debug",
      enabled: settings?.debug_mode ?? false,
    },
    { id: "keyboard", labelKey: "sidebar.keyboard", enabled: true },
    { id: "about", labelKey: "sidebar.about", enabled: true },
  ];

  const visibleTabs = tabs.filter((tab) => tab.enabled);

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-3 border-b border-mid-gray/20">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-mid-gray/20 transition-colors"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold">{t("settings.title")}</h1>
      </div>

      {/* Tab bar */}
      <div className="flex gap-4 px-6 pt-3 border-b border-mid-gray/10">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "border-b-2 border-logo-primary text-logo-primary"
                : "text-mid-gray hover:text-foreground"
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col items-center p-4 gap-4">
          {activeTab === "general" && <GeneralSettings />}
          {activeTab === "debug" && <DebugSettings />}
          {activeTab === "keyboard" && <KeyboardShortcutsSettings />}
          {activeTab === "about" && <AboutSettings />}
        </div>
      </div>
    </div>
  );
};
