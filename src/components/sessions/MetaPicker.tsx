import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus } from "lucide-react";

export interface MetaPickerItem {
  id: string;
  label: string;
  color?: string | null;
}

interface MetaPickerProps {
  items: MetaPickerItem[];
  selectedIds: string[];
  /** Tags stay open and toggle; a folder is one choice and closes. */
  multi: boolean;
  /** Mono caps label in the search row: "FOLDER", "TAGS". */
  label: string;
  placeholder: string;
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
  /** Single-choice only: a row that clears the value ("Remove from folder"). */
  clearLabel?: string;
  onClear?: () => void;
  onClose: () => void;
  /** Drawn before each label: a folder icon, or "#" for tags. */
  renderIcon: (item: MetaPickerItem) => React.ReactNode;
}

type Row =
  | { kind: "item"; item: MetaPickerItem }
  | { kind: "create"; name: string }
  | { kind: "clear" };

/**
 * One picker for folders and tags: type to filter, arrow keys and Enter to
 * pick, and a "Create" row when nothing matches exactly.
 */
export function MetaPicker({
  items,
  selectedIds,
  multi,
  label,
  placeholder,
  onPick,
  onCreate,
  clearLabel,
  onClear,
  onClose,
  renderIcon,
}: MetaPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      // The parent wraps the trigger too, so clicking it toggles cleanly.
      const scope = rootRef.current?.parentElement ?? rootRef.current;
      if (!scope?.contains(e.target as Node)) onClose();
    };
    // Escape closes the picker only; capture it before the app-wide
    // Escape (which leaves the note) can see it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? items.filter((i) => i.label.toLowerCase().includes(q))
      : items;
    const out: Row[] = matches.map((item) => ({ kind: "item", item }));
    if (q && !items.some((i) => i.label.toLowerCase() === q)) {
      out.push({ kind: "create", name: query.trim() });
    }
    if (!q && onClear && clearLabel) out.push({ kind: "clear" });
    return out;
  }, [items, query, onClear, clearLabel]);

  const bounded = Math.min(active, Math.max(0, rows.length - 1));

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "item") {
      onPick(row.item.id);
      if (!multi) onClose();
    } else if (row.kind === "create") {
      onCreate(row.name);
      setQuery("");
      if (!multi) onClose();
    } else {
      onClear?.();
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      className="absolute top-full left-0 mt-1 z-30 w-[240px] bg-background border border-border-strong rounded-lg shadow-lg"
    >
      <div className="flex items-center gap-2 h-9 px-3 border-b border-border">
        <span className="shrink-0 font-display text-label uppercase text-mid-gray">
          {label}
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) =>
                rows.length ? (i - 1 + rows.length) % rows.length : 0,
              );
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(rows[bounded]);
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-0 h-full text-ui bg-transparent text-text placeholder:text-mid-gray focus:outline-none"
        />
      </div>
      <div className="max-h-[240px] overflow-y-auto p-1">
        {rows.map((row, i) => {
          const isActive = i === bounded;
          const base = `flex items-center gap-2 w-full h-[30px] px-2.5 rounded-md text-left text-ui ${isActive ? "bg-accent/8" : ""}`;
          if (row.kind === "create") {
            return (
              <button
                key="__create__"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(row)}
                className={`${base} text-text-secondary`}
              >
                <Plus size={13} className="shrink-0" />
                <span className="truncate">
                  {t("sessions.meta.create", { name: row.name })}
                </span>
              </button>
            );
          }
          if (row.kind === "clear") {
            return (
              <button
                key="__clear__"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(row)}
                className={`${base} mt-1 text-text-secondary`}
              >
                <span className="truncate">{clearLabel}</span>
              </button>
            );
          }
          const selected = selectedIds.includes(row.item.id);
          return (
            <button
              key={row.item.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(row)}
              className={`${base} text-text`}
            >
              {renderIcon(row.item)}
              <span className="flex-1 truncate">{row.item.label}</span>
              {selected && <Check size={13} className="shrink-0" />}
            </button>
          );
        })}
        {rows.length === 0 && (
          <p className="px-2.5 py-1.5 text-xs text-text-secondary">
            {query.trim()
              ? t("palette.empty")
              : t("sessions.meta.typeToCreate")}
          </p>
        )}
      </div>
    </div>
  );
}
