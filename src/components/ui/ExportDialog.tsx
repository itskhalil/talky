import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";

export interface ExportOptions {
  notes: boolean;
  enhanced: boolean;
  transcript: boolean;
}

interface ExportDialogProps {
  open: boolean;
  title: string;
  hasEnhanced: boolean;
  onConfirm: (options: ExportOptions) => void;
  onCancel: () => void;
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  open,
  title,
  hasEnhanced,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [notes, setNotes] = useState(true);
  const [enhanced, setEnhanced] = useState(true);
  const [transcript, setTranscript] = useState(true);

  const nothingSelected =
    !notes && !transcript && !(enhanced && hasEnhanced);

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

  // Reset selections when dialog opens
  useEffect(() => {
    if (open) {
      setNotes(true);
      setEnhanced(true);
      setTranscript(true);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
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
          id="export-dialog-title"
          className="text-base font-semibold text-text mb-4"
        >
          {title}
        </h2>

        <div className="flex flex-col gap-3 mb-5">
          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={notes}
              onChange={(e) => setNotes(e.target.checked)}
              className="accent-background-ui"
            />
            {t("export.includeNotes")}
          </label>

          {hasEnhanced && (
            <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
              <input
                type="checkbox"
                checked={enhanced}
                onChange={(e) => setEnhanced(e.target.checked)}
                className="accent-background-ui"
              />
              {t("export.includeEnhanced")}
            </label>
          )}

          <label className="flex items-center gap-2 text-sm text-text cursor-pointer">
            <input
              type="checkbox"
              checked={transcript}
              onChange={(e) => setTranscript(e.target.checked)}
              className="accent-background-ui"
            />
            {t("export.includeTranscript")}
          </label>
        </div>

        {nothingSelected && (
          <p className="text-xs text-red-500 mb-3">
            {t("export.nothingSelected")}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={nothingSelected}
            onClick={() =>
              onConfirm({
                notes,
                enhanced: hasEnhanced && enhanced,
                transcript,
              })
            }
          >
            {t("menu.exportCurrentNote").replace("...", "")}
          </Button>
        </div>
      </div>
    </div>
  );
};
