import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingContainer } from "../ui/SettingContainer";
import { Button } from "../ui/Button";

interface UserDataDirectoryProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

export const UserDataDirectory: React.FC<UserDataDirectoryProps> = ({
  descriptionMode = "inline",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const [dataPath, setDataPath] = useState<string>("");
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    loadDataDirectory();
  }, []);

  const loadDataDirectory = async () => {
    try {
      const [pathResult, customResult] = await Promise.all([
        commands.getUserDataDirectory(),
        commands.hasCustomDataDirectory(),
      ]);

      if (pathResult.status === "ok") {
        setDataPath(pathResult.data);
      } else {
        setError(pathResult.error);
      }

      setIsCustom(customResult);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load data directory"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = async () => {
    if (!dataPath) return;
    try {
      await commands.openUserDataDirectory();
    } catch (openError) {
      console.error("Failed to open data directory:", openError);
    }
  };

  const handleChange = async () => {
    try {
      // Open folder picker dialog
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("settings.about.userDataDirectory.title"),
      });

      if (selected && typeof selected === "string") {
        setChanging(true);
        setError(null);
        setSuccess(false);

        // Set the new directory with migration
        const result = await commands.setDataDirectory(selected, true);

        if (result.status === "ok") {
          setDataPath(selected);
          setIsCustom(true);
          setSuccess(true);
        } else {
          setError(result.error);
        }
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("settings.about.userDataDirectory.error", { error: "Unknown" })
      );
    } finally {
      setChanging(false);
    }
  };

  const handleReset = async () => {
    try {
      setChanging(true);
      setError(null);
      setSuccess(false);

      // Reset to default (pass null and migrate data back)
      const result = await commands.setDataDirectory(null, true);

      if (result.status === "ok") {
        // Reload to get the default path
        await loadDataDirectory();
        setSuccess(true);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("settings.about.userDataDirectory.error", { error: "Unknown" })
      );
    } finally {
      setChanging(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-2"></div>
        <div className="h-8 bg-gray-100 rounded"></div>
      </div>
    );
  }

  return (
    <SettingContainer
      title={t("settings.about.userDataDirectory.title")}
      description={t("settings.about.userDataDirectory.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="stacked"
    >
      <div className="space-y-2">
        {/* Status indicator */}
        <div className="text-xs text-mid-gray">
          {isCustom
            ? t("settings.about.userDataDirectory.usingCustom")
            : t("settings.about.userDataDirectory.usingDefault")}
        </div>

        {/* Path display with actions */}
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 px-2 py-2 bg-mid-gray/10 border border-mid-gray/80 rounded text-xs font-mono break-all select-text cursor-text">
            {dataPath}
          </div>
          <Button
            onClick={handleOpen}
            variant="secondary"
            size="sm"
            disabled={!dataPath || changing}
            className="px-3 py-2"
          >
            {t("common.open")}
          </Button>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <Button
            onClick={handleChange}
            variant="secondary"
            size="sm"
            disabled={changing}
            className="px-3 py-2"
          >
            {changing
              ? t("settings.about.userDataDirectory.migrating")
              : t("settings.about.userDataDirectory.change")}
          </Button>
          {isCustom && (
            <Button
              onClick={handleReset}
              variant="secondary"
              size="sm"
              disabled={changing}
              className="px-3 py-2"
            >
              {t("settings.about.userDataDirectory.reset")}
            </Button>
          )}
        </div>

        {/* Success message */}
        {success && (
          <div className="text-xs text-green-600">
            {t("settings.about.userDataDirectory.success")}
          </div>
        )}

        {/* Error message */}
        {error && <div className="text-xs text-red-600">{error}</div>}

        {/* Restart notice */}
        {success && (
          <div className="text-xs text-amber-600">
            {t("settings.about.userDataDirectory.restartRequired")}
          </div>
        )}
      </div>
    </SettingContainer>
  );
};
