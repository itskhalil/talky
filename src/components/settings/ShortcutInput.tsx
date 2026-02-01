import React from "react";
import { GlobalShortcutInput } from "./GlobalShortcutInput";

interface ShortcutInputProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
  shortcutId: string;
  disabled?: boolean;
}

/**
 * Wrapper component that uses GlobalShortcutInput with JS keyboard events.
 * HandyKeys implementation has been removed.
 */
export const ShortcutInput: React.FC<ShortcutInputProps> = (props) => {
  return <GlobalShortcutInput {...props} />;
};
