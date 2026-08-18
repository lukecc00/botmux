import { describe, expect, it } from 'vitest';
import { buildTopicGroupMemoryFinalDeliveryPayload } from '../src/services/topic-group-memory-final-delivery.js';

describe('explicit final topic-group memory delivery', () => {
  it('reports a same-topic explicit final with its exact turn and content', () => {
    expect(buildTopicGroupMemoryFinalDeliveryPayload({
      responseKind: 'final',
      currentTurnId: ' turn-1 ',
      messageId: ' om-message ',
      content: 'final answer\nwith details',
      sameTopic: true,
    })).toEqual({
      turnId: 'turn-1',
      messageId: 'om-message',
      content: 'final answer\nwith details',
    });
  });

  it.each(['progress', 'auxiliary'] as const)(
    'does not capture %s sends as final memory',
    responseKind => {
      expect(buildTopicGroupMemoryFinalDeliveryPayload({
        responseKind,
        currentTurnId: 'turn-1',
        messageId: 'om-message',
        content: 'interim update',
        sameTopic: true,
      })).toBeUndefined();
    },
  );

  it('does not capture detached, empty, or detoured finals', () => {
    const base = {
      responseKind: 'final' as const,
      currentTurnId: 'turn-1',
      messageId: 'om-message',
      content: 'final answer',
      sameTopic: true,
    };
    expect(buildTopicGroupMemoryFinalDeliveryPayload({ ...base, currentTurnId: undefined }))
      .toBeUndefined();
    expect(buildTopicGroupMemoryFinalDeliveryPayload({ ...base, content: '   ' }))
      .toBeUndefined();
    expect(buildTopicGroupMemoryFinalDeliveryPayload({ ...base, sameTopic: false }))
      .toBeUndefined();
  });
});
