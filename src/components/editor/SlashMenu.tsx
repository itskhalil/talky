import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

export interface SlashItem {
  id: string;
  title: string;
  description?: string;
  icon: ReactNode;
  keywords?: string[];
  run: (
    editor: import("@tiptap/core").Editor,
    range: { from: number; to: number },
  ) => void;
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export interface SlashMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(
  function SlashMenu({ items, command }, ref) {
    const { t } = useTranslation();
    const [selected, setSelected] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelected(0);
    }, [items]);

    useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-slash-index="${selected}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (event) => {
        if (event.key === "ArrowDown") {
          setSelected((i) => (i + 1) % Math.max(1, items.length));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected(
            (i) =>
              (i - 1 + Math.max(1, items.length)) % Math.max(1, items.length),
          );
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-menu slash-menu--empty">
          <div className="px-3 py-2 text-xs text-text-secondary">
            {t("palette.empty")}
          </div>
        </div>
      );
    }

    return (
      <div ref={listRef} className="slash-menu">
        {items.map((item, i) => {
          const isActive = i === selected;
          return (
            <button
              key={item.id}
              type="button"
              data-slash-index={i}
              onMouseEnter={() => setSelected(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                command(item);
              }}
              className={`slash-menu__item ${isActive ? "slash-menu__item--active" : ""}`}
            >
              <span className="slash-menu__icon">{item.icon}</span>
              <span className="slash-menu__labels">
                <span className="slash-menu__title">{item.title}</span>
                {item.description && (
                  <span className="slash-menu__description">
                    {item.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    );
  },
);
