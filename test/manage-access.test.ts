import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: { dashboard: { externalHost: '10.0.0.2', port: 7891 } },
}));
vi.mock('../src/platform/binding.js', () => ({
  platformMachineBaseUrl: vi.fn(() => null),
  publicReverseProxyBaseUrl: vi.fn(() => null),
}));

import { buildManagementDashboardUrl } from '../src/core/manage-access.js';
import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from '../src/platform/binding.js';

describe('buildManagementDashboardUrl', () => {
  beforeEach(() => {
    vi.mocked(platformMachineBaseUrl).mockReturnValue(null);
    vi.mocked(publicReverseProxyBaseUrl).mockReturnValue(null);
  });

  it('uses the platform machine dashboard route without embedding a dashboard token', () => {
    vi.mocked(platformMachineBaseUrl).mockReturnValue('https://m-11585f4bd979448d.botmux.example');
    expect(buildManagementDashboardUrl()).toBe(
      'https://m-11585f4bd979448d.botmux.example/#/bot-defaults',
    );
  });

  it('uses a self-hosted public front door when configured', () => {
    vi.mocked(publicReverseProxyBaseUrl).mockReturnValue('https://botmux.example');
    expect(buildManagementDashboardUrl()).toMatch(
      /^https:\/\/botmux\.example\/(?:\?t=[^#]+)?#\/bot-defaults$/,
    );
  });
});
