import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { SettingsGroup } from "../ui/SettingsGroup";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { MemoryToggle } from "./MemoryToggle";

export const MemorySettings: React.FC = () => {
  const { t } = useTranslation();
  const [memoryContent, setMemoryContent] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadMemory = useCallback(async () => {
    const result = await commands.getMemory();
    if (result.status === "ok") {
      setMemoryContent(result.data.content || null);
    }
  }, []);

  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  const handleView = useCallback(() => {
    setIsEditing(false);
    setShowModal(true);
  }, []);

  const handleEdit = useCallback(() => {
    setEditContent(memoryContent || "");
    setIsEditing(true);
    setShowModal(true);
  }, [memoryContent]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    const result = await commands.updateMemoryContent(editContent);
    if (result.status === "ok") {
      setMemoryContent(editContent || null);
      setShowModal(false);
      setIsEditing(false);
    }
    setIsSaving(false);
  }, [editContent]);

  const handleClear = useCallback(async () => {
    const result = await commands.clearMemory();
    if (result.status === "ok") {
      setMemoryContent(null);
      setShowClearConfirm(false);
    }
  }, []);

  const hasMemory = memoryContent && memoryContent.trim().length > 0;

  return (
    <>
      <SettingsGroup title={t("settings.memory.title")}>
        <MemoryToggle descriptionMode="tooltip" grouped />
        <div className="px-4 pb-3 flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleView}
            disabled={!hasMemory}
          >
            {t("settings.memory.view")}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleEdit}>
            {t("settings.memory.edit")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowClearConfirm(true)}
            disabled={!hasMemory}
          >
            {t("settings.memory.clear")}
          </Button>
        </div>
      </SettingsGroup>

      <ConfirmDialog
        open={showClearConfirm}
        title={t("settings.memory.clearConfirm.title")}
        message={t("settings.memory.clearConfirm.message")}
        confirmLabel={t("settings.memory.clear")}
        variant="danger"
        onConfirm={handleClear}
        onCancel={() => setShowClearConfirm(false)}
      />

      {showModal && (
        <MemoryModal
          content={isEditing ? editContent : memoryContent || ""}
          isEditing={isEditing}
          isSaving={isSaving}
          onChange={setEditContent}
          onSave={handleSave}
          onClose={() => {
            setShowModal(false);
            setIsEditing(false);
          }}
          onToggleEdit={() => {
            if (!isEditing) {
              setEditContent(memoryContent || "");
              setIsEditing(true);
            } else {
              setIsEditing(false);
            }
          }}
        />
      )}
    </>
  );
};

interface MemoryModalProps {
  content: string;
  isEditing: boolean;
  isSaving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
  onToggleEdit: () => void;
}

const MemoryModal: React.FC<MemoryModalProps> = ({
  content,
  isEditing,
  isSaving,
  onChange,
  onSave,
  onClose,
  onToggleEdit,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (dialogRef.current) dialogRef.current.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative bg-background border border-border rounded-xl shadow-xl max-w-2xl w-full mx-4 p-5 outline-none flex flex-col max-h-[80vh]"
      >
        <h2 className="text-base font-semibold text-text mb-3">
          {t("settings.memory.modalTitle")}
        </h2>

        {isEditing ? (
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 min-h-[300px] w-full bg-surface border border-border rounded-lg p-3 text-sm text-text font-mono resize-none focus:outline-none focus:ring-1 focus:ring-logo-primary"
            spellCheck={false}
          />
        ) : (
          <div className="flex-1 min-h-[300px] overflow-y-auto bg-surface border border-border rounded-lg p-3">
            <pre className="text-sm text-text font-mono whitespace-pre-wrap">
              {content || t("settings.memory.empty")}
            </pre>
          </div>
        )}

        <div className="flex justify-between mt-4">
          <Button variant="secondary" size="sm" onClick={onToggleEdit}>
            {isEditing
              ? t("settings.memory.cancelEdit")
              : t("settings.memory.edit")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t("common.close")}
            </Button>
            {isEditing && (
              <Button
                variant="primary"
                size="sm"
                onClick={onSave}
                disabled={isSaving}
              >
                {isSaving ? t("common.saving") : t("common.save")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
