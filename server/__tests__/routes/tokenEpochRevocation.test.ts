/**
 * L2 (2026-06-09 security audit): access-token revocation via User.tokenEpoch.
 *
 * Covers the new auth-middleware behavior that the rest of the suite does not:
 *   - a token whose `ep` claim matches the user's tokenEpoch is accepted
 *   - bumping tokenEpoch (what password change / reset / admin reset /
 *     revoke-sessions all do) instantly invalidates previously-issued tokens
 *   - a freshly-minted token carrying the new epoch is accepted again
 *   - tokens with no `ep` claim are treated as epoch 0 (backwards-compatible
 *     rollout: tokens minted before this feature stay valid until their TTL)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import '../helpers/setup';
import { createTestUser } from '../helpers/auth';

let app: any;
let prisma: any;
const toDelete: Array<{ model: string; id: string }> = [];

beforeAll(async () => {
  app    = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  for (const { model, id } of toDelete.reverse()) {
    try { await (prisma as any)[model].delete({ where: { id } }); } catch {}
  }
  await prisma.$disconnect();
});

function signToken(userId: string, accountId: string, role: string, ep?: number) {
  const claims: any = { userId, accountId, role };
  if (ep !== undefined) claims.ep = ep;
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: '1h' });
}

describe('L2 tokenEpoch access-token revocation', () => {
  test('bumping tokenEpoch revokes outstanding tokens; a token with the new epoch works', async () => {
    const u = await createTestUser('manager');
    toDelete.push({ model: 'user', id: u.id });
    toDelete.push({ model: 'account', id: u.accountId });

    // 1) The original helper token (no `ep` claim => treated as epoch 0) is
    //    accepted while the user is still at tokenEpoch 0.
    const r1 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(r1.status).toBe(200);

    // 2) Bump tokenEpoch — exactly what password change / reset / admin reset /
    //    revoke-sessions do.
    await prisma.user.update({ where: { id: u.id }, data: { tokenEpoch: { increment: 1 } } });

    // 3) The same token is now rejected (stale epoch).
    const r2 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${u.token}`);
    expect(r2.status).toBe(401);

    // 4) A freshly-minted token carrying the new epoch is accepted again.
    const fresh = signToken(u.id, u.accountId, u.role, 1);
    const r3 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fresh}`);
    expect(r3.status).toBe(200);

    // 5) A token stamped with a stale epoch is rejected even though the
    //    signature is valid.
    const stale = signToken(u.id, u.accountId, u.role, 0);
    const r4 = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${stale}`);
    expect(r4.status).toBe(401);
  });
});
