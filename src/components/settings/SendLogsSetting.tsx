import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";
import { SettingContainer } from "../ui/SettingContainer";
import { commands } from "@/bindings";

export const SendLogsSetting: React.FC = () => {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);

  const handleClick = async () => {
    setSending(true);
    try {
      await commands.sendLogsToDeveloper(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingContainer
      title={t("sendLogs.title")}
      description={t("sendLogs.description")}
      grouped
    >
      <button
        type="button"
        onClick={handleClick}
        disabled={sending}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-text hover:text-logo-primary px-3 py-1.5 border border-mid-gray/20 rounded-md hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        <Send className="h-3.5 w-3.5" />
        {t("sendLogs.title")}
      </button>
    </SettingContainer>
  );
};
