import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  checkMicrophonePermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { commands } from "@/bindings";
import TalkyTextLogo from "../icons/TalkyTextLogo";

interface PermissionsOnboardingProps {
  onComplete: () => void;
}

interface PermissionItemProps {
  title: string;
  description: string;
  isGranted: boolean;
  isRequesting: boolean;
  onRequest: () => void;
  grantedText: string;
  grantText: string;
}

const PermissionItem: React.FC<PermissionItemProps> = ({
  title,
  description,
  isGranted,
  isRequesting,
  onRequest,
  grantedText,
  grantText,
}) => (
  <div className="flex items-center justify-between p-4 bg-background border border-mid-gray/20 rounded-lg">
    <div className="flex-1">
      <h3 className="font-medium text-text">{title}</h3>
      <p className="text-sm text-text/60">{description}</p>
    </div>
    <div className="ml-4">
      {isGranted ? (
        <span className="flex items-center gap-2 text-green-500 font-medium">
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
          {grantedText}
        </span>
      ) : (
        <button
          onClick={onRequest}
          disabled={isRequesting}
          className="px-4 py-2 bg-logo-primary text-white rounded-lg font-medium hover:bg-logo-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRequesting ? "..." : grantText}
        </button>
      )}
    </div>
  </div>
);

export const PermissionsOnboarding: React.FC<PermissionsOnboardingProps> = ({
  onComplete,
}) => {
  const { t } = useTranslation();
  const [microphoneGranted, setMicrophoneGranted] = useState(false);
  const [systemAudioRequested, setSystemAudioRequested] = useState(false);
  const [isRequestingMic, setIsRequestingMic] = useState(false);
  const [isRequestingSystemAudio, setIsRequestingSystemAudio] = useState(false);

  const checkPermissions = useCallback(async () => {
    const mic = await checkMicrophonePermission();
    setMicrophoneGranted(mic);
    return { mic };
  }, []);

  useEffect(() => {
    checkPermissions();
  }, [checkPermissions]);

  // Auto-advance when all permissions are granted/requested
  useEffect(() => {
    if (microphoneGranted && systemAudioRequested) {
      // Small delay for visual feedback
      const timer = setTimeout(onComplete, 500);
      return () => clearTimeout(timer);
    }
  }, [microphoneGranted, systemAudioRequested, onComplete]);

  const handleMicrophoneRequest = async () => {
    setIsRequestingMic(true);
    try {
      await requestMicrophonePermission();
      // Check again after request (system dialog may have been shown)
      const granted = await checkMicrophonePermission();
      setMicrophoneGranted(granted);
    } catch (error) {
      console.error("Error requesting microphone permission:", error);
    } finally {
      setIsRequestingMic(false);
    }
  };

  const handleSystemAudioRequest = async () => {
    setIsRequestingSystemAudio(true);
    try {
      await commands.requestSystemAudioPermission();
      // No way to check if granted, but the dialog was shown
      setSystemAudioRequested(true);
    } catch (error) {
      console.error("Error requesting system audio permission:", error);
    } finally {
      setIsRequestingSystemAudio(false);
    }
  };

  const allGranted = microphoneGranted && systemAudioRequested;

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center p-6 gap-6">
      <TalkyTextLogo width={200} />
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">
            {t("onboarding.permissions.title")}
          </h2>
          <p className="text-text/70">
            {t("onboarding.permissions.description")}
          </p>
        </div>

        <div className="space-y-3 text-left">
          <PermissionItem
            title={t("onboarding.permissions.microphone.title")}
            description={t("onboarding.permissions.microphone.description")}
            isGranted={microphoneGranted}
            isRequesting={isRequestingMic}
            onRequest={handleMicrophoneRequest}
            grantedText={t("onboarding.permissions.granted")}
            grantText={t("onboarding.permissions.grant")}
          />

          <PermissionItem
            title={t("onboarding.permissions.systemAudio.title")}
            description={t("onboarding.permissions.systemAudio.description")}
            isGranted={systemAudioRequested}
            isRequesting={isRequestingSystemAudio}
            onRequest={handleSystemAudioRequest}
            grantedText={t("onboarding.permissions.granted")}
            grantText={t("onboarding.permissions.grant")}
          />
        </div>

        {allGranted && (
          <p className="text-green-500 font-medium">
            {t("onboarding.permissions.allGranted")}
          </p>
        )}
      </div>
    </div>
  );
};

export default PermissionsOnboarding;
