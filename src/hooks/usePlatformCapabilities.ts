import { useState, useEffect } from "react";
import { commands, type PlatformCapabilities } from "@/bindings";

/**
 * Default capabilities for use before the backend responds
 * Assumes macOS as the default since it's the primary platform
 */
const defaultCapabilities: PlatformCapabilities = {
  speakerCapture: true,
  meetingDetection: true,
  clamshellDetection: true,
  systemSleepEvents: true,
  appleIntelligence: false,
  os: "macos",
};

/**
 * Hook to get platform capabilities from the backend.
 * This allows the frontend to adapt its UI based on what features
 * are available on the current platform.
 */
export function usePlatformCapabilities(): PlatformCapabilities {
  const [capabilities, setCapabilities] =
    useState<PlatformCapabilities>(defaultCapabilities);

  useEffect(() => {
    commands.getPlatformCapabilities().then(setCapabilities).catch(console.error);
  }, []);

  return capabilities;
}

/**
 * Check if the current platform is macOS
 */
export function useIsMacOS(): boolean {
  const capabilities = usePlatformCapabilities();
  return capabilities.os === "macos";
}

/**
 * Check if the current platform is Windows
 */
export function useIsWindows(): boolean {
  const capabilities = usePlatformCapabilities();
  return capabilities.os === "windows";
}
