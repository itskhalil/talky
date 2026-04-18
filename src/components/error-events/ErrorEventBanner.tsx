import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Send, X } from "lucide-react";
import { commands, type ErrorKind, type UserVisibleError } from "@/bindings";
import { useOsType } from "@/hooks/useOsType";
import { useTauriEvent } from "@/hooks/useTauriEvent";

/// Shows the newest undismissed error event. Clicking Send logs opens
/// Finder + mailto; Dismiss marks this specific event as seen so it never
/// re-appears (even across restarts).
export const ErrorEventBanner: React.FC = () => {
  const { t } = useTranslation();
  const os = useOsType();
  const isMac = os === "macos";
  const [events, setEvents] = useState<UserVisibleError[]>([]);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async () => {
    const list = await commands.listErrorEvents();
    setEvents(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useTauriEvent<UserVisibleError>("error-event-recorded", () => {
    void refresh();
  });

  const undismissed = useMemo(
    () => events.filter((e) => e.dismissed_at == null),
    [events],
  );

  if (undismissed.length === 0) {
    return null;
  }

  const top = undismissed[0];
  const extraCount = undismissed.length - 1;

  const handleSendLogs = async () => {
    setSending(true);
    try {
      await commands.sendLogsToDeveloper(top.kind as ErrorKind);
    } finally {
      setSending(false);
    }
  };

  const handleDismiss = async () => {
    await commands.dismissErrorEvent(top.id);
    await refresh();
  };

  return (
    <div
      className={`flex items-start gap-3 rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 mr-4 mt-3 ${
        isMac ? "ml-20" : "ml-4"
      }`}
    >
      <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-text">
          {top.title || t("errorBanner.defaultTitle")}
        </p>
        {top.detail && (
          <p className="text-xs text-text/70 mt-0.5 line-clamp-2">
            {top.detail}
          </p>
        )}
        {extraCount > 0 && (
          <p className="text-xs text-text/50 mt-1">
            {t("errorBanner.moreCount", { count: extraCount })}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleSendLogs}
          disabled={sending}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-text/80 hover:text-text px-2.5 py-1.5 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          {t("errorBanner.sendLogs")}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="inline-flex items-center gap-1 text-xs text-text/60 hover:text-text/90 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors"
          aria-label={t("errorBanner.dismiss")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
