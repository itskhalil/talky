import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { CalendarPlus, Users } from "lucide-react";
import {
  commands,
  type CalendarAttendee,
  type CalendarEvent,
} from "@/bindings";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettings } from "@/hooks/useSettings";

/**
 * How far either side of the note's start to look when the user picks a
 * meeting by hand. Wider than the auto-link window on purpose: this is the
 * escape hatch for when the guess was wrong, or when notes are written up
 * hours after the fact.
 */
const PICKER_WINDOW_MINUTES = 180;

interface MeetingChipProps {
  sessionId: string;
  /** Note start, epoch seconds — the centre of the picker's search window. */
  startedAt: number;
  /** Present when the note is linked. Changing it re-fetches the meeting. */
  calendarEventId: string | null;
}

function formatTimeRange(event: CalendarEvent): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const start = new Date(event.start_ms);
  const end = new Date(event.end_ms);
  const day = start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${day}, ${start.toLocaleTimeString(undefined, opts)}–${end.toLocaleTimeString(undefined, opts)}`;
}

/** Name to show for a participant, falling back to the raw address. */
function attendeeLabel(a: CalendarAttendee): string {
  return a.display_name ?? a.email ?? a.name ?? "";
}

export const MeetingChip: React.FC<MeetingChipProps> = ({
  sessionId,
  startedAt,
  calendarEventId,
}) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const linkMeeting = useSessionStore((s) => s.linkMeeting);
  const unlinkMeeting = useSessionStore((s) => s.unlinkMeeting);

  const calendarEnabled = getSetting("calendar_enabled") ?? false;

  const [meeting, setMeeting] = useState<CalendarEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<CalendarEvent[] | null>(null);
  const [pickerError, setPickerError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!calendarEventId) {
      setMeeting(null);
      return;
    }
    commands
      .getSessionMeeting(sessionId)
      .then((result) => {
        if (cancelled) return;
        setMeeting(result.status === "ok" ? result.data : null);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [sessionId, calendarEventId]);

  // Reset transient popover state when the note changes underneath us.
  useEffect(() => {
    setOpen(false);
    setPicking(false);
    setCandidates(null);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setPicking(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const loadCandidates = useCallback(async () => {
    setPickerError(false);
    setCandidates(null);
    const result = await commands.getMeetingsNear(
      startedAt * 1000,
      PICKER_WINDOW_MINUTES,
      PICKER_WINDOW_MINUTES,
    );
    if (result.status === "ok") {
      setCandidates(result.data);
    } else {
      console.error("Failed to load meetings:", result.error);
      setPickerError(true);
      setCandidates([]);
    }
  }, [startedAt]);

  const startPicking = () => {
    setPicking(true);
    void loadCandidates();
  };

  const others = useMemo(
    () => (meeting?.attendees ?? []).filter((a) => !a.is_current_user),
    [meeting],
  );

  if (!calendarEnabled) return null;

  const chipLabel = () => {
    if (!meeting) return t("sessions.meeting.link");
    if (others.length === 0) return t("sessions.meeting.justYou");
    const first = attendeeLabel(others[0]);
    if (others.length === 1) return first;
    // One name plus a count reads faster than three truncated names.
    return `${first} +${others.length - 1}`;
  };

  const statusNote = (a: CalendarAttendee): string | null => {
    switch (a.status) {
      case "declined":
        return t("sessions.meeting.declined");
      case "tentative":
        return t("sessions.meeting.tentative");
      case "pending":
        return t("sessions.meeting.pending");
      default:
        return null;
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !meeting) startPicking();
        }}
        className="flex items-center gap-1 rounded-md hover:text-text transition-colors"
      >
        {meeting ? <Users size={11} /> : <CalendarPlus size={11} />}
        <span>{chipLabel()}</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-background border border-border rounded-lg shadow-lg z-20 min-w-[240px] max-w-[320px] py-1">
          {picking || !meeting ? (
            <>
              <div className="px-3 py-1.5 text-xs text-text-secondary">
                {t("sessions.meeting.choose")}
              </div>
              {candidates === null ? (
                <div className="px-3 py-1.5 text-xs text-mid-gray">
                  {t("sessions.meeting.linking")}
                </div>
              ) : candidates.length === 0 ? (
                <div className="px-3 py-1.5 text-xs text-mid-gray">
                  {pickerError
                    ? t("sessions.meeting.loadError")
                    : t("sessions.meeting.noMeetingsNearby")}
                </div>
              ) : (
                candidates.map((candidate) => {
                  const guests = candidate.attendees.filter(
                    (a) => !a.is_current_user,
                  );
                  return (
                    <button
                      key={`${candidate.id}-${candidate.start_ms}`}
                      onClick={async () => {
                        setOpen(false);
                        setPicking(false);
                        await linkMeeting(sessionId, candidate);
                        setMeeting(candidate);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-accent/10 transition-colors"
                    >
                      <div className="truncate">{candidate.title}</div>
                      <div className="text-mid-gray truncate">
                        {formatTimeRange(candidate)}
                        {guests.length > 0
                          ? ` · ${t("sessions.meeting.people", { count: guests.length })}`
                          : ""}
                      </div>
                    </button>
                  );
                })
              )}
            </>
          ) : (
            <>
              <div className="px-3 py-1.5 border-b border-border/50">
                <div className="text-xs text-text truncate">
                  {meeting.title}
                </div>
                <div className="text-xs text-mid-gray">
                  {formatTimeRange(meeting)}
                </div>
              </div>
              <div className="py-1 max-h-56 overflow-y-auto">
                {others.length === 0 ? (
                  <div className="px-3 py-1 text-xs text-mid-gray">
                    {t("sessions.meeting.justYou")}
                  </div>
                ) : (
                  others.map((a, i) => {
                    const note = statusNote(a);
                    return (
                      <div
                        key={a.email ?? `${attendeeLabel(a)}-${i}`}
                        className="px-3 py-1 text-xs text-text"
                      >
                        <span className="truncate">{attendeeLabel(a)}</span>
                        {a.is_organizer && (
                          <span className="text-mid-gray">
                            {" · "}
                            {t("sessions.meeting.organizer")}
                          </span>
                        )}
                        {note && (
                          <span className="text-mid-gray">{` · ${note}`}</span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
              <div className="border-t border-border/50 py-1">
                <button
                  onClick={startPicking}
                  className="w-full text-left px-3 py-1 text-xs text-text hover:bg-accent/10 transition-colors"
                >
                  {t("sessions.meeting.change")}
                </button>
                <button
                  onClick={async () => {
                    setOpen(false);
                    setMeeting(null);
                    await unlinkMeeting(sessionId);
                  }}
                  className="w-full text-left px-3 py-1 text-xs text-text hover:bg-accent/10 transition-colors"
                >
                  {t("sessions.meeting.remove")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
