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
      const answer = (accept: boolean, id: string | number) => {
        void commands.answerModelUpgradeOffer(accept);
        toast.dismiss(id);
      };
      // Custom layout: the shared toast style puts both buttons beside the
      // text, which squeezes a two-sentence offer into a narrow column.
      toast.custom(
        (id) => (
          <div className="bg-background border border-border rounded-xl shadow-lg px-5 py-4 w-[420px] text-sm">
            <p className="font-semibold text-text">
              {t("modelUpgrade.offerTitle")}
            </p>
            <p className="text-text-secondary text-xs mt-1">
              {t("modelUpgrade.offerBody", {
                name: getTranslatedModelName(model, t),
                size: model.size_mb,
              })}
            </p>
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => answer(false, id)}
                className="text-text-secondary px-3 py-2 rounded-lg text-sm hover:bg-mid-gray/10 transition-colors"
              >
                {t("modelUpgrade.decline")}
              </button>
              <button
                onClick={() => answer(true, id)}
                className="bg-background-ui text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-background-ui/80 transition-colors"
              >
                {t("modelUpgrade.download")}
              </button>
            </div>
          </div>
        ),
        { duration: Infinity },
      );
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
