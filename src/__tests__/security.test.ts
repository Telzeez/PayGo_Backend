import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateDevice, requireAdmin } from '../middlewares/authMiddleware.js';

function mockResponse() {
  const response: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return response;
}

describe('PAYGO access-control middleware', () => {
  it('rejects hardware requests without a device API key before touching the database', async () => {
    const response = mockResponse();
    let nextCalled = false;
    await authenticateDevice(
      { params: { deviceId: 'DEVICE-001' }, header: () => undefined } as any,
      response,
      () => { nextCalled = true; }
    );
    assert.equal(response.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it('rejects non-admin users from administrator-only operations', () => {
    const response = mockResponse();
    let nextCalled = false;
    requireAdmin(
      { user: { role: 'OWNER' } } as any,
      response,
      () => { nextCalled = true; }
    );
    assert.equal(response.statusCode, 403);
    assert.equal(nextCalled, false);
  });

  it('allows an authenticated ADMIN user through the administrator guard', () => {
    const response = mockResponse();
    let nextCalled = false;
    requireAdmin(
      { user: { role: 'ADMIN' } } as any,
      response,
      () => { nextCalled = true; }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(nextCalled, true);
  });
});
