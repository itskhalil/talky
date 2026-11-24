import React from "react";
import { SettingContainer } from "./SettingContainer";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  isUpdating?: boolean;
  label: string;
  description: string;
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  tooltipPosition?: "top" | "bottom";
  /** Shown before the switch, e.g. a status indicator. */
  accessory?: React.ReactNode;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  isUpdating = false,
  label,
  description,
  descriptionMode = "tooltip",
  grouped = false,
  tooltipPosition = "top",
  accessory,
}) => {
  return (
    <SettingContainer
      title={label}
      description={description}
      descriptionMode={descriptionMode}
      grouped={grouped}
      disabled={disabled}
      tooltipPosition={tooltipPosition}
    >
      {/* Center the accessory on the switch, not on the text baseline. */}
      <div className="flex items-center gap-3">
        {accessory}
        <label
          className={`inline-flex items-center ${disabled || isUpdating ? "cursor-not-allowed" : "cursor-pointer"}`}
        >
          <input
            type="checkbox"
            value=""
            className="sr-only peer"
            checked={checked}
            disabled={disabled || isUpdating}
            onChange={(e) => onChange(e.target.checked)}
          />
          <div className="relative w-9 h-5 bg-border-strong peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-border-strong rounded-full peer peer-checked:after:translate-x-4 rtl:peer-checked:after:-translate-x-4 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-background after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-text peer-disabled:opacity-50"></div>
        </label>
      </div>
      {isUpdating && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-logo-primary border-t-transparent rounded-full animate-spin"></div>
        </div>
      )}
    </SettingContainer>
  );
};
