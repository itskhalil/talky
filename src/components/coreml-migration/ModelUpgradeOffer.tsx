import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useSessionStore } from "@/stores/sessionStore";
import { getTranslatedModelName } from "@/lib/utils/modelTranslation";

/// One-time offer to move from Parakeet v3 to Ultra, asked when nothing is
/// recording. The backend downloads and switches over between recordings;
/// this only asks, then confirms once the switch has happened.
export const ModelUpgradeOffer: React.FC = () => {
  const { t } = useTranslation();
  const isRecording = useSessionStore((s) => s.isRecording);
  const asked = useRef(false);

  useEffect(() => {
    if (isRecording || asked.current) return;
    asked.current = true;
    void commands.getModelUpgradeOffer().then((model) => {
      if (!model) return;
      const id = toast(t("modelUpgrade.offerTitle"), {
        description: t("modelUpgrade.offerBody", {
          name: getTranslatedModelName(model, t),
          size: model.size_mb,
        }),
        duration: Infinity,
        action: {
          label: t("modelUpgrade.download"),
          onClick: () => {
            void commands.answerModelUpgradeOffer(true);
            toast.dismiss(id);
          },
        },
        cancel: {
          label: t("modelUpgrade.decline"),
          onClick: () => {
            void commands.answerModelUpgradeOffer(false);
            toast.dismiss(id);
          },
        },
      });
    });
  }, [isRecording, t]);

  useTauriEvent<string>("model-upgrade-applied", (modelId) => {
    void commands.getModelInfo(modelId).then((result) => {
      if (result.status !== "ok" || !result.data) return;
      toast(
        t("modelUpgrade.appliedTitle", {
          name: getTranslatedModelName(result.data, t),
        }),
        { description: t("modelUpgrade.appliedBody") },
      );
    });
  });

  return null;
};
