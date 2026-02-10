import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { AppSettings as Settings, AudioDevice } from "@/bindings";
import { commands } from "@/bindings";

interface SettingsStore {
  settings: Settings | null;
  defaultSettings: Settings | null;
  isLoading: boolean;
  isUpdating: Record<string, boolean>;
  audioDevices: AudioDevice[];
  outputDevices: AudioDevice[];

  // Actions
  initialize: () => Promise<void>;
  loadDefaultSettings: () => Promise<void>;
  updateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => Promise<void>;
  resetSetting: (key: keyof Settings) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshAudioDevices: () => Promise<void>;
  refreshOutputDevices: () => Promise<void>;
  getSetting: <K extends keyof Settings>(key: K) => Settings[K] | undefined;
  isUpdatingKey: (key: string) => boolean;

  // Environment settings
  environmentModelOptions: Record<string, string[]>;
  createEnvironment: (
    name: string,
    color: string,
    baseUrl: string,
    apiKey: string,
    summarisationModel: string,
    chatModel: string,
  ) => Promise<void>;
  updateEnvironment: (
    id: string,
    updates: {
      name?: string;
      color?: string;
      base_url?: string;
      api_key?: string;
      summarisation_model?: string;
      chat_model?: string;
    },
  ) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<{ success: boolean; error?: string }>;
  setDefaultEnvironment: (id: string | null) => Promise<void>;
  fetchEnvironmentModels: (environmentId: string) => Promise<string[]>;
  setEnvironmentModelOptions: (environmentId: string, models: string[]) => void;

  // Internal state setters
  setSettings: (settings: Settings | null) => void;
  setDefaultSettings: (defaultSettings: Settings | null) => void;
  setLoading: (loading: boolean) => void;
  setUpdating: (key: string, updating: boolean) => void;
  setAudioDevices: (devices: AudioDevice[]) => void;
  setOutputDevices: (devices: AudioDevice[]) => void;
}

// Note: Default settings are now fetched from Rust via commands.getDefaultSettings()

const DEFAULT_AUDIO_DEVICE: AudioDevice = {
  index: "default",
  name: "Default",
  is_default: true,
};

const settingUpdaters: {
  [K in keyof Settings]?: (value: Settings[K]) => Promise<unknown>;
} = {
  font_size: (value) => commands.changeFontSizeSetting(value as any),
  autostart_enabled: (value) =>
    commands.changeAutostartSetting(value as boolean),
  update_checks_enabled: (value) =>
    commands.changeUpdateChecksSetting(value as boolean),
  selected_microphone: (value) =>
    commands.setSelectedMicrophone(
      (value as string) === "Default" || value === null
        ? "default"
        : (value as string),
    ),
  clamshell_microphone: (value) =>
    commands.setClamshellMicrophone(
      (value as string) === "Default" ? "default" : (value as string),
    ),
  selected_output_device: (value) =>
    commands.setSelectedOutputDevice(
      (value as string) === "Default" || value === null
        ? "default"
        : (value as string),
    ),
  recording_retention_period: (value) =>
    commands.updateRecordingRetentionPeriod(value as string),
  translate_to_english: (value) =>
    commands.changeTranslateToEnglishSetting(value as boolean),
  selected_language: (value) =>
    commands.changeSelectedLanguageSetting(value as string),
  debug_mode: (value) => commands.changeDebugModeSetting(value as boolean),
  custom_words: (value) => commands.updateCustomWords(value as string[]),
  history_limit: (value) => commands.updateHistoryLimit(value as number),
  post_process_enabled: (value) =>
    commands.changePostProcessEnabledSetting(value as boolean),
  post_process_selected_prompt_id: (value) =>
    commands.setPostProcessSelectedPrompt(value as string),
  log_level: (value) => commands.setLogLevel(value as any),
  app_language: (value) => commands.changeAppLanguageSetting(value as string),
  experimental_enabled: (value) =>
    commands.changeExperimentalEnabledSetting(value as boolean),
  copy_as_bullets_enabled: (value) =>
    commands.changeCopyAsBulletsSetting(value as boolean),
  word_suggestions_enabled: (value) =>
    commands.changeWordSuggestionsEnabled(value as boolean),
  speaker_energy_threshold: (value) =>
    commands.changeSpeakerEnergyThresholdSetting(value as number),
  skip_mic_on_speaker_energy: (value) =>
    commands.changeSkipMicOnSpeakerEnergySetting(value as boolean),
};

export const useSettingsStore = create<SettingsStore>()(
  subscribeWithSelector((set, get) => ({
    settings: null,
    defaultSettings: null,
    isLoading: true,
    isUpdating: {},
    audioDevices: [],
    outputDevices: [],
    environmentModelOptions: {},

    // Internal setters
    setSettings: (settings) => set({ settings }),
    setDefaultSettings: (defaultSettings) => set({ defaultSettings }),
    setLoading: (isLoading) => set({ isLoading }),
    setUpdating: (key, updating) =>
      set((state) => ({
        isUpdating: { ...state.isUpdating, [key]: updating },
      })),
    setAudioDevices: (audioDevices) => set({ audioDevices }),
    setOutputDevices: (outputDevices) => set({ outputDevices }),

    // Getters
    getSetting: (key) => get().settings?.[key],
    isUpdatingKey: (key) => get().isUpdating[key] || false,

    // Load settings from store
    refreshSettings: async () => {
      try {
        const result = await commands.getAppSettings();
        if (result.status === "ok") {
          const settings = result.data;
          const normalizedSettings: Settings = {
            ...settings,
            selected_microphone: settings.selected_microphone ?? "Default",
            clamshell_microphone: settings.clamshell_microphone ?? "Default",
            selected_output_device:
              settings.selected_output_device ?? "Default",
          };
          set({ settings: normalizedSettings, isLoading: false });
        } else {
          console.error("Failed to load settings:", result.error);
          set({ isLoading: false });
        }
      } catch (error) {
        console.error("Failed to load settings:", error);
        set({ isLoading: false });
      }
    },

    // Load audio devices
    refreshAudioDevices: async () => {
      try {
        const result = await commands.getAvailableMicrophones();
        if (result.status === "ok") {
          const devicesWithDefault = [
            DEFAULT_AUDIO_DEVICE,
            ...result.data.filter(
              (d) => d.name !== "Default" && d.name !== "default",
            ),
          ];
          set({ audioDevices: devicesWithDefault });
        } else {
          set({ audioDevices: [DEFAULT_AUDIO_DEVICE] });
        }
      } catch (error) {
        console.error("Failed to load audio devices:", error);
        set({ audioDevices: [DEFAULT_AUDIO_DEVICE] });
      }
    },

    // Load output devices
    refreshOutputDevices: async () => {
      try {
        const result = await commands.getAvailableOutputDevices();
        if (result.status === "ok") {
          const devicesWithDefault = [
            DEFAULT_AUDIO_DEVICE,
            ...result.data.filter(
              (d) => d.name !== "Default" && d.name !== "default",
            ),
          ];
          set({ outputDevices: devicesWithDefault });
        } else {
          set({ outputDevices: [DEFAULT_AUDIO_DEVICE] });
        }
      } catch (error) {
        console.error("Failed to load output devices:", error);
        set({ outputDevices: [DEFAULT_AUDIO_DEVICE] });
      }
    },

    // Update a specific setting
    updateSetting: async <K extends keyof Settings>(
      key: K,
      value: Settings[K],
    ) => {
      const { settings, setUpdating } = get();
      const updateKey = String(key);
      const originalValue = settings?.[key];

      setUpdating(updateKey, true);

      try {
        set((state) => ({
          settings: state.settings ? { ...state.settings, [key]: value } : null,
        }));

        const updater = settingUpdaters[key];
        if (updater) {
          await updater(value);
        } else if (key !== "selected_model") {
          console.warn(`No handler for setting: ${String(key)}`);
        }
      } catch (error) {
        console.error(`Failed to update setting ${String(key)}:`, error);
        if (settings) {
          set({ settings: { ...settings, [key]: originalValue } });
        }
      } finally {
        setUpdating(updateKey, false);
      }
    },

    // Reset a setting to its default value
    resetSetting: async (key) => {
      const { defaultSettings } = get();
      if (defaultSettings) {
        const defaultValue = defaultSettings[key];
        if (defaultValue !== undefined) {
          await get().updateSetting(key, defaultValue as any);
        }
      }
    },

    // Environment settings
    createEnvironment: async (
      name,
      color,
      baseUrl,
      apiKey,
      summarisationModel,
      chatModel,
    ) => {
      const { refreshSettings } = get();
      try {
        const result = await commands.createEnvironment(
          name,
          color,
          baseUrl,
          apiKey,
          summarisationModel,
          chatModel,
        );
        if (result.status === "ok") {
          await refreshSettings();
        } else {
          console.error("Failed to create environment:", result.error);
        }
      } catch (error) {
        console.error("Failed to create environment:", error);
      }
    },

    updateEnvironment: async (id, updates) => {
      const { refreshSettings } = get();
      try {
        const result = await commands.updateEnvironment(
          id,
          updates.name ?? null,
          updates.color ?? null,
          updates.base_url ?? null,
          updates.api_key ?? null,
          updates.summarisation_model ?? null,
          updates.chat_model ?? null,
        );
        if (result.status === "ok") {
          await refreshSettings();
        } else {
          console.error("Failed to update environment:", result.error);
        }
      } catch (error) {
        console.error("Failed to update environment:", error);
      }
    },

    deleteEnvironment: async (id) => {
      const { refreshSettings } = get();
      try {
        const result = await commands.deleteEnvironment(id);
        if (result.status === "ok") {
          await refreshSettings();
          return { success: true };
        } else {
          console.error("Failed to delete environment:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        console.error("Failed to delete environment:", error);
        return { success: false, error: String(error) };
      }
    },

    setDefaultEnvironment: async (id) => {
      const { refreshSettings } = get();
      if (!id) return;
      try {
        const result = await commands.setDefaultEnvironment(id);
        if (result.status === "ok") {
          await refreshSettings();
        } else {
          console.error("Failed to set default environment:", result.error);
        }
      } catch (error) {
        console.error("Failed to set default environment:", error);
      }
    },

    fetchEnvironmentModels: async (environmentId) => {
      const updateKey = `environment_models_fetch:${environmentId}`;
      const { setUpdating, setEnvironmentModelOptions } = get();
      setUpdating(updateKey, true);
      try {
        const result = await commands.fetchEnvironmentModels(environmentId);
        if (result.status === "ok") {
          setEnvironmentModelOptions(environmentId, result.data);
          return result.data;
        }
        return [];
      } catch (error) {
        console.error("Failed to fetch environment models:", error);
        return [];
      } finally {
        setUpdating(updateKey, false);
      }
    },

    setEnvironmentModelOptions: (environmentId, models) =>
      set((state) => ({
        environmentModelOptions: {
          ...state.environmentModelOptions,
          [environmentId]: models,
        },
      })),

    // Load default settings from Rust
    loadDefaultSettings: async () => {
      try {
        const result = await commands.getDefaultSettings();
        if (result.status === "ok") {
          set({ defaultSettings: result.data });
        } else {
          console.error("Failed to load default settings:", result.error);
        }
      } catch (error) {
        console.error("Failed to load default settings:", error);
      }
    },

    // Initialize everything
    initialize: async () => {
      const { refreshSettings, loadDefaultSettings } = get();

      // Note: Audio devices are NOT refreshed here. The frontend (App.tsx)
      // is responsible for calling refreshAudioDevices/refreshOutputDevices
      // after onboarding completes. This avoids triggering permission dialogs
      // on macOS before the user is ready.
      await Promise.all([loadDefaultSettings(), refreshSettings()]);
    },
  })),
);
