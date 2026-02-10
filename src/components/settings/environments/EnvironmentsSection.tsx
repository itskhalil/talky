import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, RefreshCcw, Check } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/Button";
import { SettingContainer, SettingsGroup } from "@/components/ui";
import { Input } from "@/components/ui/Input";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { ResetButton } from "@/components/ui/ResetButton";

const PRESET_COLORS = [
  "#22c55e", // green
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#84cc16", // lime
];

const ColorPicker: React.FC<{
  value: string;
  onChange: (color: string) => void;
}> = ({ value, onChange }) => {
  return (
    <div className="flex gap-2">
      {PRESET_COLORS.map((color) => (
        <button
          key={color}
          onClick={() => onChange(color)}
          className={`w-7 h-7 rounded-full transition-all ${
            value === color
              ? "ring-2 ring-offset-2 ring-offset-background ring-text/30 scale-110"
              : "hover:scale-110 opacity-70 hover:opacity-100"
          }`}
          style={{ backgroundColor: color }}
          type="button"
        />
      ))}
    </div>
  );
};

// Environment pill tab component
const EnvironmentPill: React.FC<{
  name: string;
  color: string;
  isSelected: boolean;
  isDefault: boolean;
  onClick: () => void;
}> = ({ name, color, isSelected, isDefault, onClick }) => {
  return (
    <button
      onClick={onClick}
      className={`
        flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium
        transition-all duration-200 ease-out
        ${
          isSelected
            ? "bg-accent-soft text-text shadow-sm"
            : "text-text-secondary hover:text-text hover:bg-accent-soft/50"
        }
      `}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0 transition-transform duration-200"
        style={{
          backgroundColor: color,
          transform: isSelected ? "scale(1.2)" : "scale(1)"
        }}
      />
      <span className="truncate max-w-[120px]">{name}</span>
      {isDefault && (
        <Check size={12} className="text-primary shrink-0" />
      )}
    </button>
  );
};

export const EnvironmentsSection: React.FC = () => {
  const { t } = useTranslation();
  const {
    settings,
    createEnvironment,
    updateEnvironment,
    deleteEnvironment,
    setDefaultEnvironment,
    fetchEnvironmentModels,
    environmentModelOptions,
    isUpdatingKey,
  } = useSettingsStore();

  const environments = settings?.model_environments || [];
  const defaultEnvId = settings?.default_environment_id;
  const hasEnvironments = environments.length > 0;
  const canAddMore = environments.length < 3;
  const canDelete = environments.length > 1;

  // Selected environment for editing
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null);

  // Local state for editing
  const [localName, setLocalName] = useState("");
  const [localColor, setLocalColor] = useState(PRESET_COLORS[0]);
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localApiKey, setLocalApiKey] = useState("");
  const [localSummarisationModel, setLocalSummarisationModel] = useState("");
  const [localChatModel, setLocalChatModel] = useState("");

  // Get the currently selected environment
  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  // Sync local state when selection changes
  useEffect(() => {
    if (selectedEnv) {
      setLocalName(selectedEnv.name);
      setLocalColor(selectedEnv.color);
      setLocalBaseUrl(selectedEnv.base_url);
      setLocalApiKey(selectedEnv.api_key);
      setLocalSummarisationModel(selectedEnv.summarisation_model);
      setLocalChatModel(selectedEnv.chat_model);
    }
  }, [selectedEnv]);

  // Auto-select first environment when environments change
  useEffect(() => {
    if (environments.length > 0 && !selectedEnvId) {
      setSelectedEnvId(environments[0].id);
    } else if (
      environments.length > 0 &&
      !environments.find((e) => e.id === selectedEnvId)
    ) {
      setSelectedEnvId(environments[0].id);
    }
  }, [environments, selectedEnvId]);

  const handleAddEnvironment = async () => {
    await createEnvironment(
      t("settings.environments.newEnvironmentName", "New Environment"),
      PRESET_COLORS[environments.length % PRESET_COLORS.length],
      "https://api.openai.com/v1",
      "",
      "",
      "",
    );
    // Select the newly created environment
    const newEnvs = useSettingsStore.getState().settings?.model_environments;
    if (newEnvs && newEnvs.length > 0) {
      setSelectedEnvId(newEnvs[newEnvs.length - 1].id);
    }
  };

  const handleDeleteEnvironment = async () => {
    if (!selectedEnvId || !canDelete) return;
    await deleteEnvironment(selectedEnvId);
  };

  const handleNameBlur = useCallback(() => {
    if (selectedEnvId && localName.trim() !== selectedEnv?.name) {
      updateEnvironment(selectedEnvId, { name: localName.trim() });
    }
  }, [selectedEnvId, localName, selectedEnv?.name, updateEnvironment]);

  const handleColorChange = useCallback(
    (color: string) => {
      setLocalColor(color);
      if (selectedEnvId) {
        updateEnvironment(selectedEnvId, { color });
      }
    },
    [selectedEnvId, updateEnvironment],
  );

  const handleBaseUrlBlur = useCallback(() => {
    if (selectedEnvId && localBaseUrl.trim() !== selectedEnv?.base_url) {
      updateEnvironment(selectedEnvId, { base_url: localBaseUrl.trim() });
    }
  }, [selectedEnvId, localBaseUrl, selectedEnv?.base_url, updateEnvironment]);

  const handleApiKeyBlur = useCallback(() => {
    if (selectedEnvId && localApiKey !== selectedEnv?.api_key) {
      updateEnvironment(selectedEnvId, { api_key: localApiKey });
    }
  }, [selectedEnvId, localApiKey, selectedEnv?.api_key, updateEnvironment]);

  const handleSummarisationModelSelect = useCallback(
    (model: string) => {
      setLocalSummarisationModel(model);
      if (selectedEnvId) {
        updateEnvironment(selectedEnvId, { summarisation_model: model });
      }
    },
    [selectedEnvId, updateEnvironment],
  );

  const handleChatModelSelect = useCallback(
    (model: string) => {
      setLocalChatModel(model);
      if (selectedEnvId) {
        updateEnvironment(selectedEnvId, { chat_model: model });
      }
    },
    [selectedEnvId, updateEnvironment],
  );

  const handleRefreshModels = useCallback(() => {
    if (selectedEnvId) {
      fetchEnvironmentModels(selectedEnvId);
    }
  }, [selectedEnvId, fetchEnvironmentModels]);

  const handleSetDefault = useCallback(
    (checked: boolean) => {
      if (checked && selectedEnvId) {
        setDefaultEnvironment(selectedEnvId);
      }
    },
    [selectedEnvId, setDefaultEnvironment],
  );

  const isFetchingModels = selectedEnvId
    ? isUpdatingKey(`environment_models_fetch:${selectedEnvId}`)
    : false;

  const modelOptions = selectedEnvId
    ? (environmentModelOptions[selectedEnvId] || []).map((m) => ({
        value: m,
        label: m,
      }))
    : [];

  return (
    <SettingsGroup
      title={t("settings.environments.title")}
      description={t("settings.environments.description")}
    >
      {/* Environment Tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {environments.map((env) => (
          <EnvironmentPill
            key={env.id}
            name={env.name}
            color={env.color}
            isSelected={env.id === selectedEnvId}
            isDefault={env.id === defaultEnvId}
            onClick={() => setSelectedEnvId(env.id)}
          />
        ))}
        {canAddMore && (
          <button
            onClick={handleAddEnvironment}
            className="
              flex items-center justify-center w-8 h-8 rounded-full
              text-text-secondary hover:text-text
              hover:bg-accent-soft/50 transition-colors
            "
            title={t("settings.environments.add")}
          >
            <Plus size={16} />
          </button>
        )}
        {canDelete && (
          <button
            onClick={handleDeleteEnvironment}
            className="
              flex items-center justify-center w-8 h-8 rounded-full
              text-text-secondary hover:text-red-500
              transition-colors ml-auto
            "
            title={t("settings.environments.delete")}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Environment Settings */}
      {selectedEnv && (
        <>

          {/* Name */}
          <SettingContainer
            title={t("settings.environments.name")}
            description=""
            layout="horizontal"
            grouped={true}
          >
            <Input
              type="text"
              value={localName}
              onChange={(e) => setLocalName(e.target.value)}
              onBlur={handleNameBlur}
              placeholder={t("settings.environments.namePlaceholder")}
              variant="compact"
              className="w-[200px]"
            />
          </SettingContainer>

          {/* Color */}
          <SettingContainer
            title={t("settings.environments.color")}
            description=""
            layout="horizontal"
            grouped={true}
          >
            <ColorPicker value={localColor} onChange={handleColorChange} />
          </SettingContainer>

          {/* Base URL */}
          <SettingContainer
            title={t("settings.environments.baseUrl")}
            description=""
            layout="horizontal"
            grouped={true}
          >
            <Input
              type="text"
              value={localBaseUrl}
              onChange={(e) => setLocalBaseUrl(e.target.value)}
              onBlur={handleBaseUrlBlur}
              placeholder={t("settings.environments.baseUrlPlaceholder")}
              variant="compact"
              className="w-[320px]"
            />
          </SettingContainer>

          {/* API Key */}
          <SettingContainer
            title={t("settings.environments.apiKey")}
            description=""
            layout="horizontal"
            grouped={true}
          >
            <Input
              type="password"
              value={localApiKey}
              onChange={(e) => setLocalApiKey(e.target.value)}
              onBlur={handleApiKeyBlur}
              placeholder={t("settings.environments.apiKeyPlaceholder")}
              variant="compact"
              className="w-[320px]"
            />
          </SettingContainer>

          {/* Summarisation Model */}
          <SettingContainer
            title={t("settings.environments.summarisationModel")}
            description={t("settings.environments.summarisationModelTip")}
            layout="stacked"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ModelSelect
                value={localSummarisationModel}
                options={modelOptions}
                disabled={false}
                isLoading={isFetchingModels}
                placeholder={
                  modelOptions.length > 0
                    ? t(
                        "settings.postProcessing.api.model.placeholderWithOptions",
                      )
                    : t(
                        "settings.postProcessing.api.model.placeholderNoOptions",
                      )
                }
                onSelect={handleSummarisationModelSelect}
                onCreate={handleSummarisationModelSelect}
                onBlur={() => {}}
                onMenuOpen={handleRefreshModels}
                className="flex-1"
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

          {/* Chat Model */}
          <SettingContainer
            title={t("settings.environments.chatModel")}
            description={t("settings.environments.chatModelTip")}
            layout="stacked"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ModelSelect
                value={localChatModel}
                options={modelOptions}
                disabled={false}
                isLoading={isFetchingModels}
                placeholder={
                  modelOptions.length > 0
                    ? t(
                        "settings.postProcessing.api.model.placeholderWithOptions",
                      )
                    : t(
                        "settings.postProcessing.api.model.placeholderNoOptions",
                      )
                }
                onSelect={handleChatModelSelect}
                onCreate={handleChatModelSelect}
                onBlur={() => {}}
                onMenuOpen={handleRefreshModels}
                className="flex-1"
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

          {/* Set as Default */}
          <SettingContainer
            title={t("settings.environments.setDefault")}
            description={t("settings.environments.setDefaultDescription")}
            layout="horizontal"
            grouped={true}
          >
            <input
              type="checkbox"
              checked={defaultEnvId === selectedEnvId}
              onChange={(e) => handleSetDefault(e.target.checked)}
              className="w-4 h-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
            />
          </SettingContainer>
        </>
      )}

      {/* Empty state */}
      {!hasEnvironments && (
        <div className="text-center py-12">
          <p className="text-sm text-text-secondary mb-4">
            {t("settings.environments.emptyState")}
          </p>
          <Button variant="primary" size="sm" onClick={handleAddEnvironment}>
            <Plus size={16} className="mr-1" />
            {t("settings.environments.add")}
          </Button>
        </div>
      )}
    </SettingsGroup>
  );
};
