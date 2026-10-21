import { describe, expect, it, vi } from 'vitest';
import { resolveSession } from '../../client-v2/shared/session';

const api = (token: string | null, request: (config: any) => Promise<any>) => ({
  auth: { getToken: () => token },
  request: vi.fn(request),
});

describe('resolveSession (decides what / does)', () => {
  it('treats a visitor without a stored token as anonymous without calling the server', async () => {
    const client = api(null, async () => ({ data: { data: { id: 1 } } }));
    await expect(resolveSession(client)).resolves.toBe('anonymous');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('confirms a stored token with auth:check instead of trusting it', async () => {
    const client = api('token', async () => ({ data: { data: { id: 7 } } }));
    await expect(resolveSession(client)).resolves.toBe('authenticated');
    expect(client.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'auth:check', skipAuth: true, skipNotify: true }),
    );
  });

  it('treats an expired, revoked or invalid token (401) as anonymous', async () => {
    const client = api('stale-token', async () => {
      throw Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
    });
    await expect(resolveSession(client)).resolves.toBe('anonymous');
  });

  it('treats a response without a user as anonymous', async () => {
    const client = api('token', async () => ({ data: { data: null } }));
    await expect(resolveSession(client)).resolves.toBe('anonymous');
  });

  it('treats a network failure as anonymous so / never loops', async () => {
    const client = api('token', async () => {
      throw new Error('Network Error');
    });
    await expect(resolveSession(client)).resolves.toBe('anonymous');
  });
});
