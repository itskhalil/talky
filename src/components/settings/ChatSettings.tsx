import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";

import { SettingContainer } from "@/components/ui";
import { ResetButton } from "../ui/ResetButton";
import { ProviderSelect } from "./PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "./PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "./PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "./PostProcessingSettingsApi/ModelSelect";
import { useSettings } from "../../hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DropdownOption } from "../ui/Dropdown";

const APPLE_PROVIDER_ID = "apple_intelligence";

/**
 * Chat provider/model settings — rendered inside a SettingsGroup in GeneralSettings.
 * Mirrors the PostProcessingSettingsApi layout including base URL for custom providers.
 */
export const ChatSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, isUpdating } = useSettings();
  const {
    setChatProvider,
    updateChatApiKey,
    updateChatModel,
    fetchChatModels,
    chatModelOptions,
    updatePostProcessBaseUrl,
  } = useSettingsStore();

  const providers = settings?.post_process_providers || [];
  const hideCloudModels = settings?.hide_cloud_models ?? true;
  const chatProviders = useMemo(
    () =>
      providers.filter((p) => {
        // Always exclude Apple Intelligence from chat providers
        if (p.id === APPLE_PROVIDER_ID) return false;
        // If hide_cloud_models is enabled, only show Custom
        if (hideCloudModels) return p.id === "custom";
        return true;
      }),
    [providers, hideCloudModels],
  );

  const selectedProviderId = settings?.chat_provider_id || "openai";
  const selectedProvider = chatProviders.find(
    (p) => p.id === selectedProviderId,
  );
  const isCustomProvider = selectedProvider?.id === "custom";
  const baseUrl = selectedProvider?.base_url ?? "";

  const apiKey = settings?.chat_api_keys?.[selectedProviderId] ?? "";
  const model = settings?.chat_models?.[selectedProviderId] ?? "";

  const providerOptions = useMemo<DropdownOption[]>(
    () => chatProviders.map((p) => ({ value: p.id, label: p.label })),
    [chatProviders],
  );

  const handleBaseUrlChange = useCallback(
    (value: string) => {
      if (!isCustomProvider) return;
      const trimmed = value.trim();
      if (trimmed && trimmed !== baseUrl) {
        void updatePostProcessBaseUrl(selectedProviderId, trimmed);
      }
    },
    [isCustomProvider, baseUrl, selectedProviderId, updatePostProcessBaseUrl],
  );

  const isBaseUrlUpdating = isUpdating(
    `post_process_base_url:${selectedProviderId}`,
  );

  const handleProviderSelect = useCallback(
    (providerId: string) => {
      if (providerId !== selectedProviderId) {
        void setChatProvider(providerId);
      }
    },
    [selectedProviderId, setChatProvider],
  );

  const handleApiKeyChange = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed !== apiKey) {
        void updateChatApiKey(selectedProviderId, trimmed);
      }
    },
    [apiKey, selectedProviderId, updateChatApiKey],
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
  const isApiKeyUpdating = isUpdating(`chat_api_key:${selectedProviderId}`);
  const isModelUpdating = isUpdating(`chat_model:${selectedProviderId}`);

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

      {isCustomProvider && (
        <SettingContainer
          title={t("settings.postProcessing.api.baseUrl.title")}
          description={t("settings.postProcessing.api.baseUrl.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <BaseUrlField
              value={baseUrl}
              onBlur={handleBaseUrlChange}
              placeholder={t(
                "settings.postProcessing.api.baseUrl.placeholder",
              )}
              disabled={isBaseUrlUpdating}
              className="min-w-[380px]"
            />
          </div>
        </SettingContainer>
      )}

      <SettingContainer
        title={t("settings.postProcessing.api.apiKey.title")}
        description={t("settings.chat.api.apiKey.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ApiKeyField
            value={apiKey}
            onBlur={handleApiKeyChange}
            placeholder={t("settings.postProcessing.api.apiKey.placeholder")}
            disabled={isApiKeyUpdating}
            className="min-w-[320px]"
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
