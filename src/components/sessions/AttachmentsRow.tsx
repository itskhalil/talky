import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { X, FileText, Plus, Loader } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type Attachment } from "@/bindings";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { normalizeAttachmentFilename } from "@/utils/attachmentFilename";

// File size limit: 25MB
const MAX_FILE_SIZE = 25 * 1024 * 1024;
// Maximum attachments per note
export const MAX_ATTACHMENTS = 20;
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

export interface AttachmentsRowHandle {
  openPicker: () => void;
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

function fileTypeLabel(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("image/")) return mimeType.slice(6).toUpperCase();
  return "FILE";
}

interface FileRowProps {
  attachment: Attachment;
  onOpen: () => void;
  onDelete: () => void;
  disabled: boolean;
  deleteLabel: string;
}

/** One file in the note's Files section: thumbnail, name, type and size. */
function FileRow({
  attachment,
  onOpen,
  onDelete,
  disabled,
  deleteLabel,
}: FileRowProps) {
  const isImage = attachment.mime_type.startsWith("image/");
  return (
    <div className="group flex items-center gap-3 h-11 px-2 -mx-2 rounded-md hover:bg-accent/5 transition-colors">
      <button
        onClick={onOpen}
        className="flex items-center gap-3 flex-1 min-w-0 text-left"
        title={attachment.filename}
      >
        <span className="w-8 h-8 shrink-0 flex items-center justify-center rounded border border-border overflow-hidden bg-background">
          {isImage ? (
            <img
              src={convertFileSrc(attachment.file_path)}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <FileText size={14} className="text-text-secondary" />
          )}
        </span>
        <span className="flex-1 min-w-0 truncate text-ui text-text">
          {attachment.filename}
        </span>
        <span className="shrink-0 font-mono text-label text-mid-gray">
          {fileTypeLabel(attachment.mime_type)} ·{" "}
          {formatFileSize(attachment.file_size)}
        </span>
      </button>
      {!disabled && (
        <button
          onClick={onDelete}
          className="w-6 h-6 shrink-0 flex items-center justify-center rounded text-text-secondary opacity-0 group-hover:opacity-100 hover:bg-accent/8 hover:text-text transition-opacity"
          title={deleteLabel}
          aria-label={deleteLabel}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export const AttachmentsRow = forwardRef<
  AttachmentsRowHandle,
  AttachmentsRowProps
>(function AttachmentsRow(
  { sessionId, attachments, onAttachmentsChange, disabled = false },
  ref,
) {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.mime_type.startsWith("image/")),
    [attachments],
  );

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
        const rawFilename = path.split(/[/\\]/).pop() || "file";
        const filename = normalizeAttachmentFilename(rawFilename);
        const mimeType = getMimeType(rawFilename);

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

  useImperativeHandle(ref, () => ({ openPicker: handleAddFiles }), [
    handleAddFiles,
  ]);

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

  // Nothing to show until the note has files; the ref still opens the picker.
  if (attachments.length === 0) return null;

  return (
    <section className="mt-10 pt-4 border-t border-border">
      <div className="flex items-center h-7 mb-1">
        <span className="font-display text-label uppercase text-mid-gray">
          {t("sessions.attachments.title", { count: attachments.length })}
        </span>
        <span className="flex-1" />
        {!disabled && (
          <button
            onClick={handleAddFiles}
            disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
            className="flex items-center gap-1 h-6 px-1.5 rounded-md text-xs text-text-secondary hover:bg-accent/5 hover:text-text transition-colors disabled:opacity-50"
            title={t("sessions.attachments.addHint")}
          >
            {uploading ? (
              <Loader size={12} className="animate-spin-slow" />
            ) : (
              <Plus size={12} />
            )}
            {t("sessions.attachments.addFile")}
          </button>
        )}
      </div>
      {attachments.map((att) => (
        <FileRow
          key={att.id}
          attachment={att}
          onOpen={() => {
            const idx = imageAttachments.findIndex((a) => a.id === att.id);
            if (idx !== -1) setLightboxIndex(idx);
            else void handleOpen(att.id);
          }}
          onDelete={() => handleDelete(att.id)}
          disabled={disabled}
          deleteLabel={t("sessions.attachments.delete")}
        />
      ))}
      {lightboxIndex !== null && (
        <ImageLightbox
          images={imageAttachments}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </section>
  );
});
