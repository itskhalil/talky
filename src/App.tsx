import { useEffect, useState, useRef } from "react";
import { Toaster } from "sonner";
import "./App.css";
import Onboarding, { PermissionsOnboarding } from "./components/onboarding";
import { SessionsView } from "./components/sessions/SessionsView";
import { SettingsPage } from "./components/SettingsPage";
import { useSettings } from "./hooks/useSettings";
import { useSettingsStore } from "./stores/settingsStore";
import { commands } from "@/bindings";

type OnboardingStep = "permissions" | "model" | "done";
type AppView = "notes" | "settings";

function App() {
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(
    null,
  );
  const [fromOnboarding, setFromOnboarding] = useState(false);
  const [view, setView] = useState<AppView>("notes");
  const { settings, updateSetting } = useSettings();
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const hasCompletedPostOnboardingInit = useRef(false);

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  // Refresh audio devices when main app loads
  useEffect(() => {
    if (onboardingStep === "done" && !hasCompletedPostOnboardingInit.current) {
      hasCompletedPostOnboardingInit.current = true;
      refreshAudioDevices();
      refreshOutputDevices();
      // Navigate to settings after onboarding so user can configure AI models
      if (fromOnboarding) {
        setView("settings");
      }
    }
  }, [onboardingStep, refreshAudioDevices, refreshOutputDevices, fromOnboarding]);

  // Apply font size setting
  useEffect(() => {
    const fontSizeMap = {
      small: "14px",
      medium: "16px",
      large: "18px",
    };
    const fontSize = settings?.font_size ?? "medium";
    document.documentElement.style.setProperty(
      "--font-size-base",
      fontSizeMap[fontSize] || "16px",
    );
  }, [settings?.font_size]);

  // Handle keyboard shortcuts for debug mode toggle
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+D (Windows/Linux) or Cmd+Shift+D (macOS)
      const isDebugShortcut =
        event.shiftKey &&
        event.key.toLowerCase() === "d" &&
        (event.ctrlKey || event.metaKey);

      if (isDebugShortcut) {
        event.preventDefault();
        const currentDebugMode = settings?.debug_mode ?? false;
        updateSetting("debug_mode", !currentDebugMode);
      }
    };

    // Add event listener when component mounts
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup event listener when component unmounts
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [settings?.debug_mode, updateSetting]);

  const checkOnboardingStatus = async () => {
    try {
      // Check if they have any models available
      const result = await commands.hasAnyModelsAvailable();
      if (result.status === "ok") {
        // If they have models/downloads, they're done. Otherwise start permissions step.
        setOnboardingStep(result.data ? "done" : "permissions");
      } else {
        setOnboardingStep("permissions");
      }
    } catch (error) {
      console.error("Failed to check onboarding status:", error);
      setOnboardingStep("permissions");
    }
  };

  const handlePermissionsComplete = () => {
    setOnboardingStep("model");
  };

  const handleModelSelected = () => {
    // Transition to main app - user has started a download
    setFromOnboarding(true);
    setOnboardingStep("done");
  };

  // Still checking onboarding status
  if (onboardingStep === null) {
    return null;
  }

  if (onboardingStep === "permissions") {
    return <PermissionsOnboarding onComplete={handlePermissionsComplete} />;
  }

  if (onboardingStep === "model") {
    return <Onboarding onModelSelected={handleModelSelected} />;
  }

  return (
    <div className="h-screen flex flex-col select-none cursor-default">
      <Toaster
        theme="system"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              "bg-background border border-mid-gray/20 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 text-sm",
            title: "font-medium",
            description: "text-mid-gray",
          },
        }}
      />
      <div className="flex-1 overflow-hidden">
        {view === "notes" ? (
          <SessionsView onOpenSettings={() => setView("settings")} />
        ) : (
          <SettingsPage onBack={() => setView("notes")} />
        )}
      </div>
    </div>
  );
}

export default App;
