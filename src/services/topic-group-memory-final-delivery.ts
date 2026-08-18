export type TopicGroupMemoryResponseKind = 'progress' | 'final' | 'auxiliary';

export interface TopicGroupMemoryFinalDeliveryCandidate {
  responseKind: TopicGroupMemoryResponseKind;
  currentTurnId?: string;
  messageId: string;
  content: string;
  /** True only when the successful delivery belongs to the source session's
   * own topic/chat. Detoured publish/handoff sends must not mutate the source
   * topic's shared memory. */
  sameTopic: boolean;
}

export interface TopicGroupMemoryFinalDeliveryPayload {
  turnId: string;
  messageId: string;
  content: string;
}

/** Build the daemon notification for an explicit, user-visible final.
 *
 * `botmux send` defaults to progress, so only the explicit final role is a
 * memory boundary. A detached send has no trustworthy turn/user-prompt pair,
 * and a detoured send belongs to another destination rather than the source
 * topic. Both are deliberately excluded.
 */
export function buildTopicGroupMemoryFinalDeliveryPayload(
  candidate: TopicGroupMemoryFinalDeliveryCandidate,
): TopicGroupMemoryFinalDeliveryPayload | undefined {
  if (candidate.responseKind !== 'final' || !candidate.sameTopic) return undefined;
  const turnId = candidate.currentTurnId?.trim();
  const messageId = candidate.messageId.trim();
  if (!turnId || !messageId || !candidate.content.trim()) return undefined;
  return {
    turnId,
    messageId,
    content: candidate.content,
  };
}
