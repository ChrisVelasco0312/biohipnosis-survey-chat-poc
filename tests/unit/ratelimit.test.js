import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POC_RATE_LIMIT = 'on';
const rate = await import('../../server/ratelimit.js');

test.beforeEach(() => rate.reset());

test('duplicate messages trigger a temporary cooldown', () => {
  const base = { sessionId: 'ses_test', ip: '127.0.0.1', text: 'hola', now: 1_000_000 };
  assert.equal(rate.checkInbound(base).allowed, true);
  assert.equal(rate.checkInbound({ ...base, now: 1_000_001 }).allowed, true);
  const third = rate.checkInbound({ ...base, now: 1_000_002 });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'duplicate-spam');
  assert.ok(third.retryAfterMs > 0);
});

test('per-IP token bucket caps bursts', () => {
  for (let i = 0; i < 60; i += 1) {
    const result = rate.checkInbound({
      sessionId: `ses_ip_${i}`,
      ip: '10.0.0.9',
      text: `mensaje único ${i}`,
      now: 2_000_000,
    });
    assert.equal(result.allowed, true, `request ${i}`);
  }
  const blocked = rate.checkInbound({ sessionId: 'ses_ip_final', ip: '10.0.0.9', text: 'otro', now: 2_000_000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'ip-rate-limit');
});

test('admin brute-force lockout after five failures', () => {
  const ip = '10.1.1.1';
  assert.equal(rate.checkAdmin(ip, 3_000_000).allowed, true);
  for (let i = 0; i < 5; i += 1) rate.recordAdminFailure(ip, 3_000_000 + i);
  const locked = rate.checkAdmin(ip, 3_000_010);
  assert.equal(locked.allowed, false);
  assert.ok(locked.retryAfterMs > 0);
});
