import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { ONNX_MODEL_ID } from "@/lib/constants/modelIds";

// Module-level singleton promise. React StrictMode in dev runs every effect
// twice (mount → cleanup → mount). `consume_pending_promotion` has a side
// effect — after the first call, the backend flag is cleared, so the second
// call sees `false`. Caching the promise at module scope makes the call
// happen exactly once per page load; both effect invocations share the same
// result.
let promotionPromise: Promise<boolean> | null = null;
function consumeOnce(): Promise<boolean> {
  if (!promotionPromise) {
    promotionPromise = commands.consumePendingPromotion();
  }
  return promotionPromise;
}

/// Shown on the launch after the background Core ML migration flipped
/// `selected_model` to `-coreml`. Delivered as a sonner toast (matching the
/// app's existing toast patterns) rather than a full-width banner ribbon.
/// Returns null — the hook-style usage just fires side effects on mount.
export const CoreMlPromotionBanner: React.FC = () => {
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    void consumeOnce().then((pending) => {
      if (cancelled || !pending) return;
      const id = toast(t("coremlMigration.promotionTitle"), {
        description: t("coremlMigration.promotionBody"),
        duration: Infinity,
        // action = primary (highlighted). cancel = secondary. The user
        // accepting the change is the common path, so it's the primary.
        action: {
          label: t("coremlMigration.promotionDismiss"),
          onClick: () => toast.dismiss(id),
        },
        cancel: {
          label: t("coremlMigration.promotionRevert"),
          onClick: () => {
            void commands.setActiveModel(ONNX_MODEL_ID);
            toast.dismiss(id);
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [t]);

  return null;
};
