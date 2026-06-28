import { useEffect, useRef } from 'react';

/**
 * Keep a scroll container pinned to the bottom as content streams in -- but only
 * while the user is already near the bottom. If they've scrolled up to read
 * history, new entries don't yank them back down.
 */
export function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);

  return { ref, onScroll };
}
