import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppSettings as Settings, AudioDevice } from "@/bindings";

interface UseSettingsReturn {
  // State
  settings: Settings | null;
  isLoading: boolean;
  isUpdating: (key: string) => boolean;
  audioDevices: AudioDevice[];
  outputDevices: AudioDevice[];

  // Actions
  updateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => Promise<void>;
  resetSetting: (key: keyof Settings) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshAudioDevices: () => Promise<void>;
  refreshOutputDevices: () => Promise<void>;

  // Convenience getters
  getSetting: <K extends keyof Settings>(key: K) => Settings[K] | undefined;
}

export const useSettings = (): UseSettingsReturn => {
  const store = useSettingsStore();

  // Initialize on first mount
  useEffect(() => {
    if (store.isLoading) {
      store.initialize();
    }
  }, [store.initialize, store.isLoading]);

  return {
    settings: store.settings,
    isLoading: store.isLoading,
    isUpdating: store.isUpdatingKey,
    audioDevices: store.audioDevices,
    outputDevices: store.outputDevices,
    updateSetting: store.updateSetting,
    resetSetting: store.resetSetting,
    refreshSettings: store.refreshSettings,
    refreshAudioDevices: store.refreshAudioDevices,
    refreshOutputDevices: store.refreshOutputDevices,
    getSetting: store.getSetting,
  };
};
