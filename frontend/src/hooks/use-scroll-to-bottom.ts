import { RefObject, useState, useCallback, useRef, useEffect } from "react";

export function useScrollToBottom(
  scrollRef: RefObject<HTMLDivElement | null>,
  onReachTop?: () => void,
) {
  // Track whether the user is currently near the bottom of the scroll area.
  // Used by consumers to decide whether to scroll when new UI elements appear.
  // NOT used for automatic content-following.
  const [autoscroll, setAutoscroll] = useState(true);

  // Track whether the user is currently at the bottom of the scroll area
  const [hitBottom, setHitBottom] = useState(true);

  // Store previous scroll position to detect scroll direction
  const prevScrollTopRef = useRef<number>(0);

  // Track whether the user was previously at the top, so onReachTop only fires
  // on the transition into the top region (not continuously while at the top).
  const prevHitTopRef = useRef<boolean>(false);

  // Keep the latest onReachTop callback in a ref so the scroll handler never
  // goes stale without forcing onChatBodyScroll to be recreated.
  const onReachTopRef = useRef(onReachTop);
  useEffect(() => {
    onReachTopRef.current = onReachTop;
  }, [onReachTop]);

  // Check if the scroll position is at the bottom
  const isAtBottom = useCallback((element: HTMLElement): boolean => {
    // Use a fixed 20px buffer
    const bottomThreshold = 20;
    const bottomPosition = element.scrollTop + element.clientHeight;
    return bottomPosition >= element.scrollHeight - bottomThreshold;
  }, []);

  // Check if the scroll position is at the top
  const isAtTop = useCallback((element: HTMLElement): boolean => {
    const topThreshold = 20;
    return element.scrollTop <= topThreshold;
  }, []);

  // Handle scroll events
  const onChatBodyScroll = useCallback(
    (e: HTMLElement) => {
      const isCurrentlyAtBottom = isAtBottom(e);
      setHitBottom(isCurrentlyAtBottom);

      // Get current scroll position
      const currentScrollTop = e.scrollTop;

      // Detect scroll direction
      const isScrollingUp = currentScrollTop < prevScrollTopRef.current;

      // Update previous scroll position for next comparison
      prevScrollTopRef.current = currentScrollTop;

      // Turn off autoscroll only when scrolling up
      if (isScrollingUp) {
        setAutoscroll(false);
      }

      // Turn on autoscroll when scrolled to the bottom
      if (isCurrentlyAtBottom) {
        setAutoscroll(true);
      }

      // Fire onReachTop only on the transition into the top region so it fires
      // once per reach instead of continuously while parked at the top.
      const isCurrentlyAtTop = isAtTop(e);
      if (isCurrentlyAtTop && !prevHitTopRef.current) {
        onReachTopRef.current?.();
      }
      prevHitTopRef.current = isCurrentlyAtTop;
    },
    [isAtBottom, isAtTop],
  );

  // Scroll to bottom on manual click only
  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom) {
      requestAnimationFrame(() => {
        setAutoscroll(true);
        setHitBottom(true);

        dom.scrollTop = dom.scrollHeight;
      });
    }
  }, [scrollRef]);

  return {
    scrollRef,
    autoScroll: autoscroll,
    setAutoScroll: setAutoscroll,
    scrollDomToBottom,
    hitBottom,
    setHitBottom,
    onChatBodyScroll,
  };
}
