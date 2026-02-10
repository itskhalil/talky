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
      className={`flex items-center gap-2 px-3 py-2 hover:text-text/80 transition-colors ${className}`}
      title={displayText}
    >
      <span className="truncate">{displayText}</span>
      <svg
        className={`w-3 h-3 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
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
