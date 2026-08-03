import { describe, expect, it } from 'vitest';
import { __setGroupsSnapshotForTest, buildBotCards } from '../src/dashboard/web/overview.js';

describe('dashboard overview bot cards', () => {
  it('uses /api/groups cliId for a sessionless online bot', () => {
    __setGroupsSnapshotForTest({
      chats: [],
      bots: [{
        larkAppId: 'cli_traex',
        botName: 'TraeX',
        botAvatarUrl: 'https://example.test/avatar.png',
        cliId: 'traex',
      }],
    });

    expect(buildBotCards([])).toEqual([expect.objectContaining({
      larkAppId: 'cli_traex',
      botName: 'TraeX',
      cliId: 'traex',
      online: true,
    })]);
  });

  it('does not count a legacy open session as busy without a runtime working state', () => {
    __setGroupsSnapshotForTest({ chats: [], bots: [] });

    const [card] = buildBotCards([{
      sessionId: 'legacy-open',
      larkAppId: 'cli_codex',
      botName: 'Codex',
      cliId: 'codex',
      status: 'active',
      lastMessageAt: 1_000,
    }]);

    expect(card.active).toHaveLength(1);
    expect(card.busy).toHaveLength(0);
  });
});
