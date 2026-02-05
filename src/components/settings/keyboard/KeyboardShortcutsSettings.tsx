import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const modKey = isMac ? "\u2318" : "Ctrl";

interface Shortcut {
  keys: string;
  actionKey: string;
}

const shortcuts: Shortcut[] = [
  { keys: `${modKey}+N`, actionKey: "settings.keyboard.actions.newNote" },
  { keys: `${modKey}+K`, actionKey: "settings.keyboard.actions.search" },
  { keys: `${modKey}+/`, actionKey: "settings.keyboard.actions.focusChat" },
  { keys: `${modKey}+,`, actionKey: "settings.keyboard.actions.openSettings" },
  { keys: `${modKey}+1`, actionKey: "settings.keyboard.actions.notesView" },
  { keys: `${modKey}+2`, actionKey: "settings.keyboard.actions.enhancedView" },
  { keys: `${modKey}+F`, actionKey: "settings.keyboard.actions.find" },
  {
    keys: `${modKey}+Shift+D`,
    actionKey: "settings.keyboard.actions.toggleDebug",
  },
  {
    keys: "\u2191 / \u2193",
    actionKey: "settings.keyboard.actions.navigateNotes",
  },
  { keys: "Esc", actionKey: "settings.keyboard.actions.escape" },
];

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.keyboard.title")}>
        <div className="divide-y divide-mid-gray/10">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.keys}
              className="flex items-center justify-between py-3 px-4"
            >
              <span className="text-sm">{t(shortcut.actionKey)}</span>
              <kbd className="px-2 py-1 text-xs font-mono bg-mid-gray/10 rounded border border-mid-gray/20">
                {shortcut.keys}
              </kbd>
            </div>
          ))}
        </div>
      </SettingsGroup>
    </div>
  );
};
