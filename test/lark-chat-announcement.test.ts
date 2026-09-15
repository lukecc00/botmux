import { describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { getChatAnnouncement } from '../src/im/lark/client.js';

function setRequestImpl(appId: string, request: (req: any) => Promise<any>) {
  registerBot({ larkAppId: appId, larkAppSecret: 's', cliId: 'claude-code' });
  getBot(appId).client = { request } as any;
}

describe('getChatAnnouncement', () => {
  it('prefers docx announcement blocks and renders text/link elements', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: 'docx', revision_id: 7, update_time_v2: '2026-09-15T00:00:00Z' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { heading1: { elements: [{ text_run: { content: '固定资源' } }] } },
            { text: { elements: [{ text_run: { content: 'PPE', text_element_style: { link: { url: 'https://ppe.example.com' } } } }] } },
            { project: { title: '实验面板', url: 'https://exp.example.com' } },
          ],
          has_more: false,
        },
      });
    setRequestImpl('ann_docx', request);

    await expect(getChatAnnouncement('ann_docx', 'oc_chat')).resolves.toEqual({
      text: '固定资源\nPPE (https://ppe.example.com)\n实验面板 (https://exp.example.com)',
      updatedAt: '2026-09-15T00:00:00Z',
      revision: '7',
      source: 'docx',
    });
    expect(request).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'GET',
      url: '/open-apis/docx/v1/chats/oc_chat/announcement',
    }));
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: '/open-apis/docx/v1/chats/oc_chat/announcement/blocks',
      params: { page_size: 500, revision_id: 7 },
    }));
  });

  it('falls back to legacy IM announcement when docx is unavailable', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('docx disabled'))
      .mockResolvedValueOnce({
        code: 0,
        data: {
          content: JSON.stringify({ title: '公告', content: [{ text: '规则' }, { url: 'https://rule.example.com' }] }),
          revision: 'legacy-rev',
          update_time: '1700000000000',
        },
      });
    setRequestImpl('ann_legacy', request);

    await expect(getChatAnnouncement('ann_legacy', 'oc_chat')).resolves.toEqual({
      text: '公告\n规则\nhttps://rule.example.com',
      updatedAt: '1700000000000',
      revision: 'legacy-rev',
      source: 'legacy',
    });
    expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'GET',
      url: '/open-apis/im/v1/chats/oc_chat/announcement',
    }));
  });
});
