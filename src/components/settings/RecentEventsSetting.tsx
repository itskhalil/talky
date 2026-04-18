import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Cpu,
  FileWarning,
  Send,
  Trash2,
} from "lucide-react";
import { SettingsGroup } from "../ui/SettingsGroup";
import { commands, type ErrorKind, type UserVisibleError } from "@/bindings";
import { useTauriEvent } from "@/hooks/useTauriEvent";

const iconForKind = (kind: ErrorKind) => {
  switch (kind) {
    case "native_crash":
      return AlertTriangle;
    case "sidecar_crashed":
      return Cpu;
    case "model_load_failed":
      return FileWarning;
  }
};

const formatTimestamp = (ms: number, locale: string) =>
  new Date(ms).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const RecentEventsSetting: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [events, setEvents] = useState<UserVisibleError[]>([]);
  const [sending, setSending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await commands.listErrorEvents();
    setEvents(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useTauriEvent("error-event-recorded", () => {
    void refresh();
  });

  const handleSendLogs = async (event: UserVisibleError) => {
    setSending(event.id);
    try {
      await commands.sendLogsToDeveloper(event.kind as ErrorKind);
    } finally {
      setSending(null);
    }
  };

  const handleClearAll = async () => {
    await commands.clearErrorEvents();
    setEvents([]);
  };

  return (
    <SettingsGroup title={t("recentEvents.title")}>
      {events.length === 0 ? (
        <div className="px-4 py-6 text-sm text-text/60 text-center">
          {t("recentEvents.empty")}
        </div>
      ) : (
        <>
          <div className="divide-y divide-mid-gray/10">
            {events.map((event) => {
              const Icon = iconForKind(event.kind);
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <Icon className="h-4 w-4 text-text/60 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text">
                      {event.title ||
                        t(`recentEvents.kind.${event.kind}`)}
                    </p>
                    {event.detail && (
                      <p className="text-xs text-text/60 mt-0.5 line-clamp-2">
                        {event.detail}
                      </p>
                    )}
                    <p className="text-xs text-text/40 mt-1">
                      {formatTimestamp(
                        Number(event.timestamp_ms),
                        i18n.language,
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSendLogs(event)}
                    disabled={sending === event.id}
                    className="inline-flex items-center gap-1.5 text-xs text-text/70 hover:text-text px-2 py-1 rounded-md hover:bg-white/5 disabled:opacity-50 transition-colors shrink-0"
                  >
                    <Send className="h-3 w-3" />
                    {t("recentEvents.sendLogs")}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex justify-end px-4 py-2 border-t border-mid-gray/10">
            <button
              type="button"
              onClick={handleClearAll}
              className="inline-flex items-center gap-1.5 text-xs text-text/60 hover:text-red-400 px-2 py-1 rounded-md transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              {t("recentEvents.clearAll")}
            </button>
          </div>
        </>
      )}
    </SettingsGroup>
  );
};
