/**
 * server/lib/webhookImport.ts
 *
 * Fires the per-account import webhook (event: "assets.imported") after a
 * successful bulk CSV/XLSX commit.
 *
 * Uses the same SSRF-guard + HMAC-signing + retry loop as the general-purpose
 * lib/webhook.ts delivery.  On final failure the result is logged to the
 * WebhookDelivery table with status "failed"; on success, status "delivered".
 *
 * The per-account URL + secret live on the Account row, stored encrypted.
 * decryptIfEncrypted is called here before use.
 */

'use strict';

import prisma from './prisma';

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { validateWebhookUrl, postOnce } = require('./webhook');
const { decryptIfEncrypted } = require('./crypto');

const RETRY_BACKOFF_MS = [1000, 4000, 16000]; // before attempts #2/#3/#4
const MAX_ATTEMPTS     = RETRY_BACKOFF_MS.length + 1; // 4
const TIMEOUT_MS       = 8000;

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function signPayload(body: string, timestamp: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${timestamp}.${body}`, 'utf8');
  return 'sha256=' + hmac.digest('hex');
}

export interface ImportedAssetSummary {
  id: string;
  name: string;
  serialNumber: string | null;
  siteId: string;
}

export interface ImportWebhookPayload {
  event: 'assets.imported';
  accountId: string;
  importedCount: number;
  failedCount: number;
  timestamp: string;
  assets: ImportedAssetSummary[];
}

/**
 * Attempt to deliver the assets.imported webhook for an account.
 * Fires silently (never throws) — import must not fail because a webhook did.
 *
 * @param accountId  The tenant account.
 * @param payload    The import result payload to deliver.
 */
export async function fireImportWebhook(
  accountId: string,
  payload: ImportWebhookPayload,
): Promise<void> {
  // Load the account's import webhook config.
  const account = await prisma.account.findUnique({
    where:  { id: accountId },
    select: { importWebhookUrl: true, importWebhookSecret: true },
  });

  if (!account?.importWebhookUrl || !account?.importWebhookSecret) {
    return; // not configured — nothing to do
  }

  const url    = decryptIfEncrypted(account.importWebhookUrl);
  const secret = decryptIfEncrypted(account.importWebhookSecret);

  if (!url || !secret) return;

  // SSRF guard
  const { valid, addresses } = await validateWebhookUrl(url).catch(() => ({ valid: false, addresses: [] }));
  if (!valid) {
    await logDelivery({ accountId, payload, deliveryId: uuidv4(), status: 'failed',
                        error: 'ssrf-rejected', statusCode: null, responseMs: null });
    return;
  }

  const deliveryId = uuidv4();
  const bodyStr    = JSON.stringify(payload);
  const timestamp  = String(Math.floor(Date.now() / 1000));
  const signature  = signPayload(bodyStr, timestamp, secret);

  let lastResult: any = null;
  const t0 = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_BACKOFF_MS[attempt - 2]);
    lastResult = await postOnce({
      url, addresses, body: bodyStr, signature, timestamp, deliveryId,
      timeoutMs: TIMEOUT_MS,
    });
    if (lastResult.ok) break;
    // 4xx (non-408/429) = permanent client error, don't retry
    const s = lastResult.status;
    if (s && s >= 400 && s < 500 && s !== 408 && s !== 429) break;
  }

  const responseMs = Date.now() - t0;
  await logDelivery({
    accountId,
    payload,
    deliveryId,
    status:     lastResult?.ok ? 'delivered' : 'failed',
    statusCode: lastResult?.status ?? null,
    responseMs,
    error:      lastResult?.ok ? null : String(lastResult?.reason ?? 'unknown').slice(0, 1000),
  });
}

async function logDelivery({
  accountId, payload, deliveryId, status, statusCode, responseMs, error,
}: {
  accountId:  string;
  payload:    ImportWebhookPayload;
  deliveryId: string;
  status:     string;
  statusCode: number | null;
  responseMs: number | null;
  error:      string | null;
}): Promise<void> {
  try {
    await prisma.webhookDelivery.create({
      data: {
        accountId,
        event:      payload.event,
        deliveryId,
        status,
        statusCode,
        responseMs,
        error,
        payload:    payload as any,
      },
    });
  } catch (err: any) {
    // Logging must never throw — swallow silently
    console.warn('[webhookImport] logDelivery error:', err?.message);
  }
}

export {};
