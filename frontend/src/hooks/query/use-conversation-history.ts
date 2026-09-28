import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import EventService from "#/api/event-service/event-service.api";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import type { OpenHandsEvent } from "#/types/v1/core";

const HISTORY_PAGE_SIZE = 100;

interface HistoryPage {
  items: OpenHandsEvent[];
  nextPageId: string | null;
}

export const useConversationHistory = (conversationId?: string) => {
  const { data: conversation, isFetched: isConversationFetched } =
    useUserConversation(conversationId ?? null);

  const query = useInfiniteQuery({
    queryKey: ["conversation-history", conversationId],
    enabled: !!conversationId && !!conversation,
    queryFn: async ({ pageParam }): Promise<HistoryPage> => {
      if (!conversationId) return { items: [], nextPageId: null };

      return EventService.searchEventsV1(
        conversationId,
        HISTORY_PAGE_SIZE,
        "TIMESTAMP_DESC",
        pageParam,
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextPageId,
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000, // 30 minutes — survive navigation away and back (AC5)
  });

  const {
    data,
    isLoading,
    isError,
    error,
    isFetched: isQueryFetched,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = query;

  // Flatten pages (newest-first) back into chronological (oldest-first) order.
  const flattened = useMemo(() => {
    if (!data) return [] as OpenHandsEvent[];
    const pages = data.pages.filter(
      (page): page is HistoryPage => !!page && !!page.items?.length,
    );
    const events: OpenHandsEvent[] = [];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      // Each page is returned newest-first (TIMESTAMP_DESC); reverse it so the
      // flattened list is chronological (oldest-first) end-to-end.
      events.push(...[...pages[i].items].reverse());
    }
    return events;
  }, [data]);

  return {
    data: flattened,
    isLoading,
    isError,
    error,
    // Query is considered fetched when:
    // 1. Conversation data is fetched AND history query has run, OR
    // 2. Conversation doesn't exist (isConversationFetched && !conversation)
    isFetched: isQueryFetched || (isConversationFetched && !conversation),
    hasMore: !!hasNextPage,
    isFetchingOlder: isFetchingNextPage,
    loadOlder: fetchNextPage,
  };
};
