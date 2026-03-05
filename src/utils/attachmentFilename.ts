const SCREENSHOT_PATTERN =
  /^Screenshot[ _]\d{4}-\d{2}-\d{2}[ _](?:at[ _])?(\d{2})[.\-](\d{2})[.\-](\d{2})(?:\s+(\d+))?\.\w+$/i;

export function normalizeAttachmentFilename(filename: string): string {
  const match = SCREENSHOT_PATTERN.exec(filename);
  if (match) {
    const ext = filename.split(".").pop() || "png";
    const time = `${match[1]}${match[2]}${match[3]}`;
    const suffix = match[4] ? `-${match[4]}` : "";
    return `screenshot-${time}${suffix}.${ext}`;
  }
  return filename;
}
