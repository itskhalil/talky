import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { SettingContainer } from "../ui/SettingContainer";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { commands, type WordSuggestion } from "@/bindings";
import { Check, X } from "lucide-react";

interface CustomWordsProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const CustomWords: React.FC<CustomWordsProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const [newWord, setNewWord] = useState("");
    const [suggestions, setSuggestions] = useState<WordSuggestion[]>([]);
    const customWords = getSetting("custom_words") || [];
    const wordSuggestionsEnabled = getSetting("word_suggestions_enabled") ?? true;

    const MAX_WORDS_PER_PHRASE = 5;

    // Fetch suggestions on mount
    useEffect(() => {
      const fetchSuggestions = async () => {
        const result = await commands.getWordSuggestions();
        setSuggestions(result);
      };
      fetchSuggestions();
    }, []);

    const handleApproveSuggestion = async (word: string) => {
      const result = await commands.approveWordSuggestion(word);
      if (result.status === "ok") {
        setSuggestions((prev) => prev.filter((s) => s.word !== word));
        // Refresh custom words
        const updated = [...customWords, word];
        updateSetting("custom_words", updated);
      }
    };

    const handleDismissSuggestion = async (word: string) => {
      const result = await commands.dismissWordSuggestion(word);
      if (result.status === "ok") {
        setSuggestions((prev) => prev.filter((s) => s.word !== word));
      }
    };

    const handleAddWord = () => {
      const trimmedWord = newWord.trim();
      // Normalize multiple spaces to single space
      const normalizedWord = trimmedWord.replace(/\s+/g, " ");
      const sanitizedWord = normalizedWord.replace(/[<>"'&]/g, "");
      const wordCount = sanitizedWord.split(" ").length;

      if (
        sanitizedWord &&
        sanitizedWord.length <= 100 &&
        wordCount <= MAX_WORDS_PER_PHRASE &&
        !customWords.includes(sanitizedWord)
      ) {
        updateSetting("custom_words", [...customWords, sanitizedWord]);
        setNewWord("");
      }
    };

    const handleRemoveWord = (wordToRemove: string) => {
      updateSetting(
        "custom_words",
        customWords.filter((word) => word !== wordToRemove),
      );
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddWord();
      }
    };

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.customWords.title")}
          description={t("settings.advanced.customWords.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <div className="flex items-center gap-2">
            <Input
              type="text"
              className="max-w-40"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={handleKeyPress}
              placeholder={t("settings.advanced.customWords.placeholder")}
              variant="compact"
              disabled={isUpdating("custom_words")}
            />
            <Button
              onClick={handleAddWord}
              disabled={
                !newWord.trim() ||
                newWord.trim().replace(/\s+/g, " ").split(" ").length >
                  MAX_WORDS_PER_PHRASE ||
                newWord.trim().length > 100 ||
                isUpdating("custom_words")
              }
              variant="primary"
              size="md"
            >
              {t("settings.advanced.customWords.add")}
            </Button>
          </div>
        </SettingContainer>
        {/* Auto-suggestions toggle */}
        <ToggleSwitch
          checked={wordSuggestionsEnabled}
          onChange={(enabled) => updateSetting("word_suggestions_enabled", enabled)}
          isUpdating={isUpdating("word_suggestions_enabled")}
          label={t("settings.advanced.customWords.autoSuggestLabel", "Auto-suggest words")}
          description={t("settings.advanced.customWords.autoSuggestDescription", "Suggest new words when you correct transcription errors in enhanced notes")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        />
        {/* Suggestions section */}
        {wordSuggestionsEnabled && suggestions.length > 0 && (
          <div
            className={`px-4 py-3 ${grouped ? "" : "rounded-lg border border-amber-500/30 bg-amber-500/5"}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                {t("settings.advanced.customWords.suggestions", "Suggestions")}
                <span className="ml-1.5 text-text-secondary">({suggestions.length})</span>
              </span>
            </div>
            <div className="space-y-1.5">
              {suggestions.map((suggestion) => (
                <div
                  key={suggestion.word}
                  className="flex items-center justify-between gap-2 py-1"
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{suggestion.word}</span>
                    <span className="text-xs text-text-secondary ml-2">
                      {t("settings.advanced.customWords.from", "from")} {suggestion.source_session_title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleApproveSuggestion(suggestion.word)}
                      className="p-1 rounded hover:bg-green-500/10 text-green-600 dark:text-green-400 transition-colors"
                      title={t("settings.advanced.customWords.approve", "Add to custom words")}
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={() => handleDismissSuggestion(suggestion.word)}
                      className="p-1 rounded hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-colors"
                      title={t("settings.advanced.customWords.dismiss", "Dismiss")}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {customWords.length > 0 && (
          <div
            className={`px-4 p-2 ${grouped ? "" : "rounded-lg border border-mid-gray/20"} flex flex-wrap gap-1`}
          >
            {customWords.map((word) => (
              <Button
                key={word}
                onClick={() => handleRemoveWord(word)}
                disabled={isUpdating("custom_words")}
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1 cursor-pointer"
                aria-label={t("settings.advanced.customWords.remove", { word })}
              >
                <span>{word}</span>
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </Button>
            ))}
          </div>
        )}
      </>
    );
  },
);
