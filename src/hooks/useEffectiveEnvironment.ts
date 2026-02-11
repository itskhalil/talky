import { useSettingsStore } from "@/stores/settingsStore";
import type { ModelEnvironment } from "@/bindings";

interface EffectiveEnvironmentResult {
  environment: ModelEnvironment | null;
  environmentId: string | null;
  baseUrl: string;
  apiKey: string;
  summarisationModel: string;
  chatModel: string;
  isConfigured: boolean;
}

/**
 * Resolves the effective environment for a given session.
 * Priority: sessionEnvironmentId → defaultEnvironmentId → first environment
 */
export function useEffectiveEnvironment(
  sessionEnvironmentId?: string | null,
): EffectiveEnvironmentResult {
  const settings = useSettingsStore((state) => state.settings);
  const environments = settings?.model_environments ?? [];
  const defaultEnvId = settings?.default_environment_id;

  const effectiveId =
    sessionEnvironmentId ?? defaultEnvId ?? environments[0]?.id;
  const environment = environments.find((e) => e.id === effectiveId) ?? null;

  return {
    environment,
    environmentId: environment?.id ?? null,
    baseUrl: environment?.base_url ?? "",
    apiKey: environment?.api_key ?? "",
    summarisationModel: environment?.summarisation_model ?? "",
    chatModel: environment?.chat_model ?? "",
    isConfigured: !!environment?.base_url && !!environment?.api_key,
  };
}

/**
 * Non-hook version for use in callbacks where you need current state.
 * Gets the effective environment from the current store state.
 */
export function getEffectiveEnvironment(
  sessionEnvironmentId?: string | null,
): EffectiveEnvironmentResult {
  const settings = useSettingsStore.getState().settings;
  const environments = settings?.model_environments ?? [];
  const defaultEnvId = settings?.default_environment_id;

  const effectiveId =
    sessionEnvironmentId ?? defaultEnvId ?? environments[0]?.id;
  const environment = environments.find((e) => e.id === effectiveId) ?? null;

  return {
    environment,
    environmentId: environment?.id ?? null,
    baseUrl: environment?.base_url ?? "",
    apiKey: environment?.api_key ?? "",
    summarisationModel: environment?.summarisation_model ?? "",
    chatModel: environment?.chat_model ?? "",
    isConfigured: !!environment?.base_url && !!environment?.api_key,
  };
}
