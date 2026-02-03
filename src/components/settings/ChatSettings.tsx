import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";

import { SettingContainer } from "@/components/ui";
import { ResetButton } from "../ui/ResetButton";
import { ProviderSelect } from "./PostProcessingSettingsApi/ProviderSelect";
import { ModelSelect } from "./PostProcessingSettingsApi/ModelSelect";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DropdownOption } from "../ui/Dropdown";

const APPLE_PROVIDER_ID = "apple_intelligence";
const OLLAMA_PROVIDER_ID = "ollama";

/**
 * Chat provider/model settings — rendered inside a SettingsGroup in GeneralSettings.
 * Uses the same providers as PostProcessing (summarization) - base URL is configured there.
 */
export const ChatSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, isUpdating } = useSettings();
  const {
    setChatProvider,
    updateChatModel,
    fetchChatModels,
    chatModelOptions,
  } = useSettingsStore();

  const providers = settings?.post_process_providers || [];
  const hideCloudModels = settings?.hide_cloud_models ?? true;
  const chatProviders = useMemo(
    () =>
      providers.filter((p) => {
        // Always exclude Apple Intelligence from chat providers
        if (p.id === APPLE_PROVIDER_ID) return false;
        // If hide_cloud_models is enabled, show Custom and Ollama (local providers)
        if (hideCloudModels) return p.id === "custom" || p.id === OLLAMA_PROVIDER_ID;
        return true;
      }),
    [providers, hideCloudModels],
  );

  const selectedProviderId = settings?.chat_provider_id || "openai";
  const selectedProvider = chatProviders.find(
    (p) => p.id === selectedProviderId,
  );

  const model = settings?.chat_models?.[selectedProviderId] ?? "";

  const providerOptions = useMemo<DropdownOption[]>(
    () => chatProviders.map((p) => ({ value: p.id, label: p.label })),
    [chatProviders],
  );

  const handleProviderSelect = useCallback(
    (providerId: string) => {
      if (providerId !== selectedProviderId) {
        void setChatProvider(providerId);
      }
    },
    [selectedProviderId, setChatProvider],
  );

  const handleModelSelect = useCallback(
    (value: string) => {
      void updateChatModel(selectedProviderId, value.trim());
    },
    [selectedProviderId, updateChatModel],
  );

  const handleModelCreate = useCallback(
    (value: string) => {
      void updateChatModel(selectedProviderId, value);
    },
    [selectedProviderId, updateChatModel],
  );

  const handleRefreshModels = useCallback(() => {
    void fetchChatModels(selectedProviderId);
  }, [fetchChatModels, selectedProviderId]);

  const availableModelsRaw = chatModelOptions[selectedProviderId] || [];
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    const upsert = (v: string | null | undefined) => {
      const trimmed = v?.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      options.push({ value: trimmed, label: trimmed });
    };
    for (const m of availableModelsRaw) upsert(m);
    upsert(model);
    return options;
  }, [availableModelsRaw, model]);

  const isFetchingModels = isUpdating(
    `chat_models_fetch:${selectedProviderId}`,
  );
  const isModelUpdating = isUpdating(`chat_model:${selectedProviderId}`);

  // Suppress unused variable warning - selectedProvider used for potential future features
  void selectedProvider;

  return (
    <>
      <SettingContainer
        title={t("settings.postProcessing.api.provider.title")}
        description={t("settings.chat.api.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ProviderSelect
            options={providerOptions}
            value={selectedProviderId}
            onChange={handleProviderSelect}
          />
        </div>
      </SettingContainer>

      <SettingContainer
        title={t("settings.postProcessing.api.model.title")}
        description={t("settings.chat.api.model.description")}
        descriptionMode="tooltip"
        layout="stacked"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ModelSelect
            value={model}
            options={modelOptions}
            disabled={isModelUpdating}
            isLoading={isFetchingModels}
            placeholder={
              modelOptions.length > 0
                ? t(
                    "settings.postProcessing.api.model.placeholderWithOptions",
                  )
                : t("settings.postProcessing.api.model.placeholderNoOptions")
            }
            onSelect={handleModelSelect}
            onCreate={handleModelCreate}
            onBlur={() => {}}
            onMenuOpen={handleRefreshModels}
            className="flex-1 min-w-[380px]"
          />
          <ResetButton
            onClick={handleRefreshModels}
            disabled={isFetchingModels}
            ariaLabel={t("settings.postProcessing.api.model.refreshModels")}
            className="flex h-10 w-10 items-center justify-center"
          >
            <RefreshCcw
              className={`h-4 w-4 ${isFetchingModels ? "animate-spin" : ""}`}
            />
          </ResetButton>
        </div>
      </SettingContainer>
    </>
  );
};
