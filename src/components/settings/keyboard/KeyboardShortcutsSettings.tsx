import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { useSettingsStore } from "@/stores/settingsStore";
import { getKeyName, normalizeKey, type OSType } from "@/lib/utils/keyboard";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const modKey = isMac ? "\u2318" : "Ctrl";
const osType: OSType = isMac
  ? "macos"
  : navigator.platform.toUpperCase().includes("WIN")
    ? "windows"
    : "linux";

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

/** Modifier keys in the order they should appear in a shortcut string */
const MODIFIER_ORDER = ["command", "ctrl", "option", "alt", "shift", "super"];

function isModifier(key: string): boolean {
  return MODIFIER_ORDER.includes(key);
}

/**
 * Convert a frontend key name to the Tauri global-shortcut format.
 * e.g. "command+shift+r" -> "Command+Shift+R"
 */
function toTauriShortcut(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      const lower = part.trim().toLowerCase();
      switch (lower) {
        case "command":
          return "Command";
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "option":
          return "Alt";
        case "shift":
          return "Shift";
        case "super":
          return "Super";
        default:
          // Capitalize first letter for regular keys (e.g. "r" -> "R", "f1" -> "F1")
          if (lower.match(/^f\d+$/)) {
            return lower.toUpperCase();
          }
          return part.trim().toUpperCase();
      }
    })
    .join("+");
}

/** Format a Tauri shortcut string for display with platform-appropriate symbols */
function formatShortcutDisplay(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => {
      const lower = part.trim().toLowerCase();
      if (isMac) {
        switch (lower) {
          case "command":
            return "\u2318";
          case "ctrl":
            return "\u2303";
          case "alt":
            return "\u2325";
          case "shift":
            return "\u21E7";
          default:
            return part.trim().toUpperCase();
        }
      }
      return part.trim();
    })
    .join(isMac ? "" : "+");
}

const GlobalShortcutInput: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettingsStore();
  const [isRecording, setIsRecording] = useState(false);
  const [currentKeys, setCurrentKeys] = useState<Set<string>>(new Set());
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const committedComboRef = useRef<string | null>(null);

  const currentShortcut = settings?.new_recording_shortcut ?? null;

  const startRecording = useCallback(() => {
    setIsRecording(true);
    setCurrentKeys(new Set());
    pressedKeysRef.current = new Set();
    committedComboRef.current = null;
  }, []);

  const commitShortcut = useCallback(
    async (combo: string) => {
      const tauriCombo = toTauriShortcut(combo);
      try {
        await updateSetting("new_recording_shortcut", tauriCombo);
      } catch (err) {
        toast.error(String(err));
      }
      setIsRecording(false);
      setCurrentKeys(new Set());
    },
    [updateSetting],
  );

  const clearShortcut = useCallback(async () => {
    try {
      await updateSetting("new_recording_shortcut", null as any);
    } catch (err) {
      toast.error(String(err));
    }
  }, [updateSetting]);

  useEffect(() => {
    if (!isRecording) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = normalizeKey(getKeyName(e, osType));
      if (key.startsWith("unknown")) return;

      pressedKeysRef.current.add(key);
      setCurrentKeys(new Set(pressedKeysRef.current));

      // Build the current combo (modifiers sorted, then non-modifier key)
      const keys = Array.from(pressedKeysRef.current);
      const modifiers = keys
        .filter(isModifier)
        .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
      const nonModifiers = keys.filter((k) => !isModifier(k));

      if (modifiers.length > 0 && nonModifiers.length > 0) {
        committedComboRef.current = [...modifiers, ...nonModifiers].join("+");
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const key = normalizeKey(getKeyName(e, osType));
      pressedKeysRef.current.delete(key);

      // Commit when all keys are released
      if (pressedKeysRef.current.size === 0 && committedComboRef.current) {
        commitShortcut(committedComboRef.current);
      }
    };

    // Use capture to intercept before the app's own shortcuts
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [isRecording, commitShortcut]);

  // Cancel recording on blur (e.g. user switches away)
  useEffect(() => {
    if (!isRecording) return;

    const handleBlur = () => {
      setIsRecording(false);
      setCurrentKeys(new Set());
    };

    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [isRecording]);

  const displayKeys = Array.from(currentKeys);
  const sortedDisplay = [
    ...displayKeys
      .filter(isModifier)
      .sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b)),
    ...displayKeys.filter((k) => !isModifier(k)),
  ];

  return (
    <div className="flex items-center justify-between py-3 px-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{t("settings.keyboard.newRecording")}</span>
        <span className="text-xs text-mid-gray">
          {t("settings.keyboard.newRecordingDescription")}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {isRecording ? (
          <button
            className="px-3 py-1.5 text-xs font-mono bg-accent/10 text-accent rounded border border-accent/30 min-w-[120px] text-center animate-pulse"
            onClick={() => {
              setIsRecording(false);
              setCurrentKeys(new Set());
            }}
          >
            {sortedDisplay.length > 0
              ? sortedDisplay.join("+")
              : t("settings.keyboard.pressKeys")}
          </button>
        ) : (
          <button
            className="px-3 py-1.5 text-xs font-mono bg-mid-gray/10 rounded border border-mid-gray/20 min-w-[120px] text-center hover:bg-mid-gray/20 transition-colors"
            onClick={startRecording}
          >
            {currentShortcut
              ? formatShortcutDisplay(currentShortcut)
              : t("settings.keyboard.noShortcutSet")}
          </button>
        )}
        {currentShortcut && !isRecording && (
          <button
            className="px-2 py-1.5 text-xs text-mid-gray hover:text-text-primary transition-colors"
            onClick={clearShortcut}
          >
            {t("settings.keyboard.clearShortcut")}
          </button>
        )}
      </div>
    </div>
  );
};

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup
        title={t("settings.keyboard.globalShortcuts")}
        description={t("settings.keyboard.globalShortcutsDescription")}
      >
        <GlobalShortcutInput />
      </SettingsGroup>

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
