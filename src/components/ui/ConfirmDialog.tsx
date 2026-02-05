import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = "danger",
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  // Focus trap
  useEffect(() => {
    if (open && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const confirmButtonVariant = variant === "danger" ? "danger" : "primary";
  const confirmButtonClass =
    variant === "warning"
      ? "!bg-amber-500 !border-amber-500 hover:!bg-amber-600 hover:!border-amber-600"
      : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative bg-background border border-border rounded-xl shadow-xl max-w-sm w-full mx-4 p-5 outline-none"
      >
        <h2
          id="confirm-dialog-title"
          className="text-base font-semibold text-text mb-2"
        >
          {title}
        </h2>
        <p className="text-sm text-text-secondary mb-5">{message}</p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel || t("common.cancel")}
          </Button>
          <Button
            variant={confirmButtonVariant}
            size="sm"
            onClick={onConfirm}
            className={confirmButtonClass}
          >
            {confirmLabel || t("common.delete")}
          </Button>
        </div>
      </div>
    </div>
  );
};
