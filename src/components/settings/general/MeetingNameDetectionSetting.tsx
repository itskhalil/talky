import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import { useSettings } from "@/hooks/useSettings";
import { usePlatformCapabilities } from "@/hooks/usePlatformCapabilities";

async function permissionsApi() {
  return import("tauri-plugin-macos-permissions-api");
}

async function isAccessibilityGranted(): Promise<boolean | null> {
  try {
    return await (await permissionsApi()).checkAccessibilityPermission();
  } catch (e) {
    console.warn("Failed to check Accessibility permission", e);
    return null;
  }
}

async function requestAccessibility(): Promise<void> {
  try {
    await (await permissionsApi()).requestAccessibilityPermission();
  } catch (e) {
    console.warn("Failed to request Accessibility permission", e);
  }
}

/** While the permission is missing, re-check this often, so the status
 * updates when the user returns from System Settings. */
const RECHECK_MS = 2000;

export const MeetingNameDetectionSetting: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const capabilities = usePlatformCapabilities();
  const [granted, setGranted] = useState<boolean | null>(null);

  const enabled = getSetting("meeting_name_detection") ?? false;
  const supported = capabilities.meetingDetection;

  const refresh = useCallback(async () => {
    setGranted(await isAccessibilityGranted());
  }, []);

  useEffect(() => {
    if (!supported || !enabled) return;
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [supported, enabled, refresh]);

  useEffect(() => {
    if (!supported || !enabled || granted !== false) return;
    const id = window.setInterval(() => void refresh(), RECHECK_MS);
    return () => window.clearInterval(id);
  }, [supported, enabled, granted, refresh]);

  if (!supported) return null;

  const handleChange = async (value: boolean) => {
    // Reading other apps' window titles needs the Accessibility permission.
    if (value && !(await isAccessibilityGranted())) {
      await requestAccessibility();
    }
    updateSetting("meeting_name_detection", value);
  };

  const handleRequest = async () => {
    await requestAccessibility();
    await refresh();
  };

  let accessory: React.ReactNode = null;
  if (enabled && granted === true) {
    accessory = (
      <span
        className="inline-flex items-center gap-1 text-xs text-text-secondary"
        title={t("settings.recording.meetingNameDetection.grantedHint")}
      >
        <Check className="w-3.5 h-3.5 text-green-500" />
        {t("settings.recording.meetingNameDetection.granted")}
      </span>
    );
  } else if (enabled && granted === false) {
    accessory = (
      <button
        type="button"
        onClick={() => void handleRequest()}
        title={t("settings.recording.meetingNameDetection.missingHint")}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-amber-600 hover:bg-accent/8 transition-colors"
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        {t("settings.recording.meetingNameDetection.missing")}
      </button>
    );
  }

  return (
    <ToggleSwitch
      checked={enabled}
      onChange={(value) => void handleChange(value)}
      isUpdating={isUpdating("meeting_name_detection")}
      label={t("settings.recording.meetingNameDetection.label")}
      description={t("settings.recording.meetingNameDetection.description")}
      descriptionMode="tooltip"
      grouped
      accessory={accessory}
    />
  );
});

MeetingNameDetectionSetting.displayName = "MeetingNameDetectionSetting";
