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
    <div className="flex flex-col h-screen ground">
      {/* Drag region for window dragging; the traffic lights sit on the ground */}
      <div data-tauri-drag-region className="h-9 w-full shrink-0" />
      <div className="flex-1 min-h-0 mx-2 mb-2 flex flex-col bg-background border border-border rounded-md overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 h-12 shrink-0 border-b border-border">
          <button
            onClick={onBack}
            aria-label={t("common.back")}
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:bg-accent/8 hover:text-text transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-title font-normal tracking-[-0.02em]">
            {t("settings.title")}
          </h1>
        </div>

        {/* Tab bar */}
        <div className="flex gap-4 px-4 pt-3 shrink-0 border-b border-border">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-2 text-ui transition-colors ${
                activeTab === tab.id
                  ? "text-text shadow-[inset_0_-2px_0_var(--color-text)]"
                  : "text-text-secondary hover:text-text"
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
    </div>
  );
};
