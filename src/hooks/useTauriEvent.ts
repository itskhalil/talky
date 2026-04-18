import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/// Subscribe to a Tauri event for the lifetime of the component. The handler
/// is kept in a ref so callers don't need to memoize it — changing the handler
/// between renders doesn't re-subscribe.
export function useTauriEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listen<T>(eventName, (event) =>
        handlerRef.current(event.payload),
      );
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [eventName]);
}
