import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  MessageCircle,
  Send,
  X,
  Loader2,
  RotateCcw,
  ChevronDown,
} from "lucide-react";
import { useNoteChat, type ChatMessage } from "@/hooks/useNoteChat";

interface ChatDrawerProps {
  sessionId: string;
  getTranscript: () => string;
  getUserNotes: () => string;
}

export function ChatDrawer({
  sessionId,
  getTranscript,
  getUserNotes,
}: ChatDrawerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    messages,
    input,
    setInput,
    handleSubmit,
    handleInputFocus,
    isLoading,
    stop,
    clearMessages,
    error,
  } = useNoteChat({ sessionId, getTranscript, getUserNotes });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (expanded) {
      inputRef.current?.focus();
    }
  }, [expanded]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const onFocus = useCallback(() => {
    if (!expanded) setExpanded(true);
    handleInputFocus();
  }, [expanded, handleInputFocus]);

  return (
    <div className="absolute bottom-20 right-4 z-10 w-80">
      {expanded ? (
        <div className="bg-background border border-border-strong rounded-xl shadow-lg flex flex-col overflow-hidden" style={{ maxHeight: "50vh" }}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <MessageCircle size={14} className="text-text-secondary" />
              <span className="text-xs font-medium text-text">
                {t("sessions.chat.newChat")}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <button
                  onClick={clearMessages}
                  className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                  title={t("sessions.chat.newChat")}
                >
                  <RotateCcw size={12} />
                </button>
              )}
              <button
                onClick={() => setExpanded(false)}
                className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-[100px]">
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}
            {isLoading &&
              messages[messages.length - 1]?.role !== "assistant" && (
                <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <Loader2 size={12} className="animate-spin" />
                  {t("sessions.chat.thinking")}
                </div>
              )}
            {error && (
              <div className="text-xs text-red-400 px-1 py-1">
                {error}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                data-ui
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={handleInputFocus}
                placeholder={t("sessions.chat.placeholder")}
                className="flex-1 text-xs bg-transparent outline-none placeholder:text-text-secondary/40"
              />
              {isLoading ? (
                <button
                  onClick={stop}
                  className="p-1 rounded-md text-text-secondary/50 hover:text-text-secondary transition-colors"
                >
                  <X size={14} />
                </button>
              ) : (
                <button
                  onClick={handleSubmit}
                  disabled={!input.trim()}
                  className="p-1 rounded-md text-accent hover:text-accent/70 transition-colors disabled:opacity-30"
                >
                  <Send size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setExpanded(true)}
          onFocus={onFocus}
          className="w-full flex items-center gap-2 px-3 py-2 bg-background border border-border-strong rounded-xl shadow-sm hover:border-border-strong/80 transition-colors"
        >
          <MessageCircle size={14} className="text-text-secondary/50" />
          <span className="text-xs text-text-secondary/50">
            {t("sessions.chat.placeholder")}
          </span>
        </button>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
          isUser
            ? "bg-accent/10 text-text"
            : "bg-background-secondary text-text"
        }`}
      >
        <span className="whitespace-pre-wrap">{message.content}</span>
        {!isUser && message.content === "" && (
          <Loader2 size={12} className="animate-spin text-text-secondary" />
        )}
      </div>
    </div>
  );
}
