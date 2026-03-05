const SCREENSHOT_PATTERN =
  /^Screenshot[ _]\d{4}-\d{2}-\d{2}[ _](?:at[ _])?\d{2}[.\-]\d{2}[.\-]\d{2}(?:\s*\d+)?\.\w+$/i;

export function normalizeAttachmentFilename(
  filename: string,
  attachmentCount: number,
): string {
  if (SCREENSHOT_PATTERN.test(filename)) {
    const ext = filename.split(".").pop() || "png";
    return `screenshot-${(attachmentCount + 1).toString().padStart(3, "0")}.${ext}`;
  }
  return filename;
}
