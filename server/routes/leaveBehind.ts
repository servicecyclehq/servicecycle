/**
 * routes/leaveBehind.ts — POST /api/work-orders/:id/leave-behind-pdf
 *
 * Generates the 3-section inspection leave-behind PDF (Task 28):
 *   1. What We Found — deficiencies from this work order
 *   2. What We Fixed — resolved deficiencies
 *   3. What to Budget For — open QuoteRequests + RUL-scored assets >= 0.70
 *
 * The data assembly + render lives in lib/leaveBehindData so the #16
 * auto-send-on-completion path produces the identical document.
 *
 * Auth: any authenticated user on the account.
 * Also mounted at POST /api/inspections/:id/leave-behind-pdf (alias).
 */

const router = require('express').Router({ mergeParams: true });
import { buildLeaveBehindPdf } from '../lib/leaveBehindData';

router.post('/', async (req: any, res: any) => {
  const { id } = req.params;
  const { accountId } = req.user;

  try {
    const built = await buildLeaveBehindPdf(accountId, id);
    if (!built) return res.status(404).json({ error: 'Work order not found' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${built.filename}"`);
    res.setHeader('Content-Length', built.pdfBuffer.length);
    res.send(built.pdfBuffer);
  } catch (err: any) {
    console.error('[leaveBehind] render failed:', err.message);
    res.status(500).json({ error: 'Failed to generate leave-behind PDF' });
  }
});

module.exports = router;
