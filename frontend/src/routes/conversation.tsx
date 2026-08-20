import React from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";

import { useConversationId } from "#/hooks/use-conversation-id";
import { useCommandStore } from "#/stores/command-store";
import { useConversationStore } from "#/stores/conversation-store";
import { useAgentStore } from "#/stores/agent-store";
import { useV1ConversationStateStore } from "#/stores/v1-conversation-state-store";
import { AgentState } from "#/types/agent-state";

import { EventHandler } from "../wrapper/event-handler";

import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useTaskPolling } from "#/hooks/query/use-task-polling";

import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { useIsAuthed } from "#/hooks/query/use-is-authed";
import { ConversationSubscriptionsProvider } from "#/context/conversation-subscriptions-provider";

import { ConversationMain } from "#/components/features/conversation/conversation-main/conversation-main";
import { ConversationNameWithStatus } from "#/components/features/conversation/conversation-name-with-status";
import { ArchivedConversationView } from "#/components/features/conversation/archived-conversation-view";

import { ConversationTabs } from "#/components/features/conversation/conversation-tabs/conversation-tabs";
import { WebSocketProviderWrapper } from "#/contexts/websocket-provider-wrapper";
import { useErrorMessageStore } from "#/stores/error-message-store";
import { I18nKey } from "#/i18n/declaration";
import { useEventStore } from "#/stores/use-event-store";

function AppContent() {
  const { t } = useTranslation();
  const { conversationId } = useConversationId();
  const clearEvents = useEventStore((state) => state.clearEvents);

  // Handle both task IDs (task-{uuid}) and regular conversation IDs.
  // A task ID is not a conversation UUID and must never reach conversation APIs.
  const { isTask, taskStatus, taskDetail } = useTaskPolling();

  const { data: conversation, isFetched } = useActiveConversation();
  const { data: isAuthed } = useIsAuthed();
  const { resetConversationState } = useConversationStore();
  const navigate = useNavigate();
  const clearTerminal = useCommandStore((state) => state.clearTerminal);
  const resetV1ConversationState = useV1ConversationStateStore(
    (state) => state.reset,
  );
  const setCurrentAgentState = useAgentStore(
    (state) => state.setCurrentAgentState,
  );
  const removeErrorMessage = useErrorMessageStore(
    (state) => state.removeErrorMessage,
  );

  // 1. Cleanup Effect - runs when navigating to a different conversation
  React.useEffect(() => {
    clearTerminal();
    resetConversationState();
    resetV1ConversationState();
    setCurrentAgentState(AgentState.LOADING);
    removeErrorMessage();
    clearEvents();
  }, [
    conversationId,
    clearTerminal,
    resetConversationState,
    resetV1ConversationState,
    setCurrentAgentState,
    removeErrorMessage,
    clearEvents,
  ]);

  // 2. Task Error Display Effect
  React.useEffect(() => {
    if (isTask && taskStatus === "ERROR") {
      displayErrorToast(
        taskDetail || t(I18nKey.CONVERSATION$FAILED_TO_START_FROM_TASK),
      );
    }
  }, [isTask, taskStatus, taskDetail, t]);

  // 3. Handle conversation not found
  // NOTE: Resuming STOPPED conversations is handled by useSandboxRecovery in WebSocketProviderWrapper
  React.useEffect(() => {
    // A task URL is intentionally not a conversation yet. Task polling will
    // replace it with the real conversation UUID when the backend reports READY.
    if (isTask) return;

    // Wait for data to be fetched
    if (!isFetched || !isAuthed) return;

    // Handle conversation not found
    if (!conversation) {
      displayErrorToast(t(I18nKey.CONVERSATION$NOT_EXIST_OR_NO_PERMISSION));
      navigate("/");
    }
  }, [isTask, conversation, isFetched, isAuthed, navigate, t]);

  // Task IDs are temporary start-task handles, not conversation UUIDs. Keep the
  // route in a lightweight polling state until useTaskPolling replaces the URL
  // with the actual conversation ID. In particular, do not mount websocket or
  // conversation providers here because they call APIs that require UUIDs.
  if (isTask) {
    const statusText =
      taskStatus === "ERROR"
        ? taskDetail || taskStatus
        : taskStatus?.replaceAll("_", " ");

    return (
      <div
        data-testid="conversation-start-task-gate"
        className="flex h-full items-center justify-center"
      >
        <div className="flex flex-col items-center gap-3 text-tertiary-alt">
          {taskStatus !== "ERROR" && (
            <div
              aria-hidden="true"
              className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
          )}
          {statusText && <span>{statusText}</span>}
        </div>
      </div>
    );
  }

  // Check if this is an archived conversation (sandbox no longer exists)
  const isArchived = conversation?.sandbox_status === "MISSING";

  // For archived conversations, show a simplified read-only view
  // similar to the shared conversation view
  if (isArchived) {
    return (
      <WebSocketProviderWrapper conversationId={conversationId}>
        <ConversationSubscriptionsProvider>
          <EventHandler>
            <div data-testid="app-route" className="flex flex-col h-full gap-3">
              <ArchivedConversationView />
            </div>
          </EventHandler>
        </ConversationSubscriptionsProvider>
      </WebSocketProviderWrapper>
    );
  }

  const content = (
    <ConversationSubscriptionsProvider>
      <EventHandler>
        <div
          data-testid="app-route"
          className="p-3 md:p-0 flex flex-col h-full gap-3"
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4.5 pt-2 lg:pt-0">
            <ConversationNameWithStatus />
            <ConversationTabs />
          </div>

          <ConversationMain />
        </div>
      </EventHandler>
    </ConversationSubscriptionsProvider>
  );

  // Render WebSocket provider immediately for real conversation UUIDs only.
  return (
    <WebSocketProviderWrapper conversationId={conversationId}>
      {content}
    </WebSocketProviderWrapper>
  );
}

function App() {
  return <AppContent />;
}

export default App;
