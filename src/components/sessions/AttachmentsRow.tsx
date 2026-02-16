import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Paperclip, X, FileText, Image, Plus, Loader2 } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type Attachment } from "@/bindings";

// File size limit: 25MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;
// Maximum attachments per note
const MAX_ATTACHMENTS = 10;
// Supported MIME types
const SUPPORTED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];
// Supported extensions
const SUPPORTED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "gif", "webp"];

interface AttachmentsRowProps {
  sessionId: string;
  attachments: Attachment[];
  onAttachmentsChange: () => void;
  disabled?: boolean;
}

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string) {
  if (mimeType === "application/pdf") {
    return <FileText size={12} className="text-red-400" />;
  }
  if (mimeType.startsWith("image/")) {
    return <Image size={12} className="text-blue-400" />;
  }
  return <Paperclip size={12} className="text-text-secondary" />;
}

function isValidExtension(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop() || "";
  return SUPPORTED_EXTENSIONS.includes(ext);
}

interface AttachmentChipProps {
  attachment: Attachment;
  onOpen: () => void;
  onDelete: () => void;
  disabled: boolean;
  t: (key: string) => string;
}

function AttachmentChip({
  attachment,
  onOpen,
  onDelete,
  disabled,
  t,
}: AttachmentChipProps) {
  const [showPreview, setShowPreview] = useState(false);
  const isImage = attachment.mime_type.startsWith("image/");
  const previewUrl = isImage ? convertFileSrc(attachment.file_path) : null;

  return (
    <div
      className="group relative inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs bg-accent/5 text-text hover:bg-accent/10 transition-colors"
      onMouseEnter={() => isImage && setShowPreview(true)}
      onMouseLeave={() => setShowPreview(false)}
    >
      {getFileIcon(attachment.mime_type)}
      <button
        onClick={onOpen}
        className="hover:underline truncate max-w-[150px]"
        title={`${attachment.filename} (${formatFileSize(attachment.file_size)})`}
      >
        {attachment.filename}
      </button>
      {!disabled && (
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
          title={t("sessions.attachments.delete")}
        >
          <X size={10} />
        </button>
      )}

      {/* Image preview tooltip */}
      {showPreview && previewUrl && (
        <div className="absolute bottom-full left-0 mb-2 p-1 bg-background border border-border rounded-lg shadow-lg z-50">
          <img
            src={previewUrl}
            alt={attachment.filename}
            className="max-w-[200px] max-h-[150px] rounded object-contain"
          />
        </div>
      )}
    </div>
  );
}

export function AttachmentsRow({
  sessionId,
  attachments,
  onAttachmentsChange,
  disabled = false,
}: AttachmentsRowProps) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Handle file upload (shared between dialog and drag-drop)
  const uploadFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;

      // Check if adding these would exceed the limit
      if (attachments.length + paths.length > MAX_ATTACHMENTS) {
        toast.error(
          t("sessions.attachments.tooManyFiles", { count: MAX_ATTACHMENTS }),
        );
        return;
      }

      setUploading(true);

      for (const path of paths) {
        const filename = path.split(/[/\\]/).pop() || "file";
        const mimeType = getMimeType(filename);

        if (!SUPPORTED_TYPES.includes(mimeType)) {
          toast.error(t("sessions.attachments.unsupportedType"));
          continue;
        }

        try {
          const attachment = await invoke<{ id: string; mime_type: string }>(
            "add_attachment",
            {
              sessionId,
              sourcePath: path,
              filename,
              mimeType,
            },
          );

          // Extract PDF text in background
          if (attachment.mime_type === "application/pdf") {
            invoke("extract_pdf_text", { attachmentId: attachment.id }).catch(
              (e) => console.warn("PDF text extraction failed:", e),
            );
          }
        } catch (e) {
          console.error("Failed to add attachment:", e);
          toast.error(t("sessions.attachments.uploadError"));
        }
      }

      onAttachmentsChange();
      setUploading(false);
    },
    [sessionId, attachments.length, t, onAttachmentsChange],
  );

  const handleAddFiles = useCallback(async () => {
    if (disabled || uploading) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      toast.error(
        t("sessions.attachments.tooManyFiles", { count: MAX_ATTACHMENTS }),
      );
      return;
    }

    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Documents",
            extensions: SUPPORTED_EXTENSIONS,
          },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      await uploadFiles(paths);
    } catch (e) {
      console.error("Failed to open file dialog:", e);
    }
  }, [disabled, uploading, attachments.length, t, uploadFiles]);

  const handleDelete = useCallback(
    async (attachmentId: string) => {
      try {
        await invoke("delete_attachment", { attachmentId });
        onAttachmentsChange();
      } catch (e) {
        console.error("Failed to delete attachment:", e);
      }
    },
    [onAttachmentsChange],
  );

  const handleOpen = useCallback(async (attachmentId: string) => {
    try {
      await invoke("open_attachment", { attachmentId });
    } catch (e) {
      console.error("Failed to open attachment:", e);
    }
  }, []);

  // Drag and drop handlers
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the drop zone entirely
    if (
      dropZoneRef.current &&
      !dropZoneRef.current.contains(e.relatedTarget as Node)
    ) {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled || uploading) return;

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // Filter to valid files and check extensions
      const validFiles = files.filter((f) => isValidExtension(f.name));
      if (validFiles.length === 0) {
        toast.error(t("sessions.attachments.unsupportedType"));
        return;
      }

      // For drag-drop in Tauri, we get File objects but need paths
      // Unfortunately, web File objects don't expose full paths for security
      // We need to use the file dialog for now - drag-drop will only work
      // if Tauri's fs plugin supports it in the future
      // For now, show a message to use the file picker
      toast.info(t("sessions.attachments.addFiles"));
      handleAddFiles();
    },
    [disabled, uploading, t, handleAddFiles],
  );

  // Don't render anything if no attachments and disabled
  if (attachments.length === 0 && disabled) {
    return null;
  }

  return (
    <div
      ref={dropZoneRef}
      className={`flex items-center gap-2 flex-wrap mt-2 p-2 -mx-2 rounded-md transition-colors ${
        isDragging
          ? "bg-accent/10 border border-dashed border-accent"
          : "border border-transparent"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Paperclip size={12} className="text-text-secondary/50" />

      {/* Attachment chips */}
      {attachments.map((att) => (
        <AttachmentChip
          key={att.id}
          attachment={att}
          onOpen={() => handleOpen(att.id)}
          onDelete={() => handleDelete(att.id)}
          disabled={disabled}
          t={t}
        />
      ))}

      {/* Add button */}
      {!disabled && (
        <button
          onClick={handleAddFiles}
          disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs text-text-secondary hover:bg-accent/10 transition-colors disabled:opacity-50"
          title={t("sessions.attachments.add")}
        >
          {uploading ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Plus size={10} />
          )}
          {attachments.length === 0 && (
            <span>{t("sessions.attachments.add")}</span>
          )}
        </button>
      )}

      {/* Drop zone indicator */}
      {isDragging && (
        <span className="text-xs text-accent">
          {t("sessions.attachments.addFiles")}
        </span>
      )}
    </div>
  );
}
