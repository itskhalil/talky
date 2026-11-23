/**
 * Effective alert for a meeting-end action. "Keep recording" without any
 * alert would leave the user unaware, so "none" falls back to a notification.
 */
export const effectiveMeetingEndAlert = (
  action: string,
  alert: string,
): string =>
  action === "notify" && alert === "none" ? "os_notification" : alert;
