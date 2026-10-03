import React from "react";

interface ModelStatusButtonProps {
  displayText: string;
  isDropdownOpen: boolean;
  onClick: () => void;
  className?: string;
}

const ModelStatusButton: React.FC<ModelStatusButtonProps> = ({
  displayText,
  isDropdownOpen,
  onClick,
  className = "",
}) => {
  return (
    <button
      onClick={onClick}
      className={`h-8 px-2.5 min-w-[200px] max-w-[280px] flex items-center justify-between gap-2 text-sm text-left bg-background border rounded-md transition-colors ${isDropdownOpen ? "border-border-strong" : "border-border hover:border-border-strong"} ${className}`}
      title={displayText}
    >
      <span className="truncate">{displayText}</span>
      <svg
        className={`w-4 h-4 shrink-0 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 9l-7 7-7-7"
        />
      </svg>
    </button>
  );
};

export default ModelStatusButton;
