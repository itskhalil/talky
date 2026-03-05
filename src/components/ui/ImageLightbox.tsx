import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { type Attachment } from "@/bindings";

interface ImageLightboxProps {
  images: Attachment[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const { t } = useTranslation();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const containerRef = useRef<HTMLDivElement>(null);

  const hasMultiple = images.length > 1;

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % images.length);
  }, [images.length]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
  }, [images.length]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" && hasMultiple) {
        e.stopPropagation();
        goNext();
      } else if (e.key === "ArrowLeft" && hasMultiple) {
        e.stopPropagation();
        goPrev();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, goNext, goPrev, hasMultiple]);

  // Focus container on mount
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Prevent body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Preload adjacent images
  useEffect(() => {
    if (!hasMultiple) return;
    const preload = (index: number) => {
      const img = new Image();
      img.src = convertFileSrc(images[index].file_path);
    };
    preload((currentIndex + 1) % images.length);
    preload((currentIndex - 1 + images.length) % images.length);
  }, [currentIndex, images, hasMultiple]);

  const handleSave = useCallback(async () => {
    const image = images[currentIndex];
    const ext = image.filename.split(".").pop() || "png";
    const destination = await save({
      defaultPath: image.filename,
      filters: [{ name: "Image", extensions: [ext] }],
    });
    if (!destination) return;
    try {
      await invoke("save_attachment", {
        attachmentId: image.id,
        destination,
      });
    } catch (e) {
      console.error("Failed to save image:", e);
    }
  }, [images, currentIndex]);

  const current = images[currentIndex];
  const src = convertFileSrc(current.file_path);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center outline-none"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Top-right buttons */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
        <button
          onClick={handleSave}
          className="p-2 text-white/70 hover:text-white transition-colors"
          title={t("sessions.attachments.lightboxSave")}
        >
          <Download size={20} />
        </button>
        <button
          onClick={onClose}
          className="p-2 text-white/70 hover:text-white transition-colors"
          title={t("sessions.attachments.lightboxClose")}
        >
          <X size={24} />
        </button>
      </div>

      {/* Previous button */}
      {hasMultiple && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          className="absolute left-4 z-10 p-2 text-white/70 hover:text-white transition-colors"
          title={t("sessions.attachments.lightboxPrev")}
        >
          <ChevronLeft size={32} />
        </button>
      )}

      {/* Image */}
      <img
        src={src}
        alt={current.filename}
        className="relative z-10 max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />

      {/* Next button */}
      {hasMultiple && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          className="absolute right-4 z-10 p-2 text-white/70 hover:text-white transition-colors"
          title={t("sessions.attachments.lightboxNext")}
        >
          <ChevronRight size={32} />
        </button>
      )}

      {/* Counter */}
      {hasMultiple && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 text-white/70 text-sm">
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>
  );
}
