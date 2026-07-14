/**
 * lib/zipInflateGuard.ts — decompression-bomb guard for ZIP / OOXML buffers.
 *
 * WHY: a .docx is a ZIP, and the backfill importer accepts a .zip. The ZIP
 * central-directory "uncompressed size" field is attacker-controlled metadata —
 * it is NOT verified against what the DEFLATE stream actually inflates to. A
 * crafted archive can declare a tiny uncompressed size while its compressed
 * stream inflates to gigabytes (a classic zip bomb). Any guard that sums the
 * DECLARED sizes can be bypassed by simply lying in the header.
 *
 * WHAT THIS DOES: it inflates each entry's REAL DEFLATE output and counts the
 * ACTUAL bytes produced, aborting the instant the running total would exceed the
 * budget — it never trusts the declared uncompressed (or compressed) size at all.
 *
 * MEMORY SAFETY: inflation uses zlib.inflateRawSync with `maxOutputLength`. This
 * is memory-bounded and aborts EARLY: verified on Node v24.15.0 that a 512 MB
 * bomb (521 KB on disk) throws ERR_BUFFER_TOO_LARGE in ~23 ms with a peak output
 * allocation of ~the cap (≈64 MB), NOT 512 MB — zlib stops decoding at the cap
 * rather than fully inflating the entry into memory first. Each entry's output
 * buffer is read for its length then discarded, so the pass itself never holds
 * more than a single entry's (capped) output at once.
 *
 * FAILS CLOSED: on anything it cannot verify with certainty — ZIP64 size/offset
 * sentinels, an unrecognised compression method, a malformed structure, or a
 * central directory it cannot locate — it returns ok:false (reject). It NEVER
 * fails open (there is deliberately no "couldn't parse, so allow" path), which
 * is the exact fail-open bug this replaces.
 */

'use strict';

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CDH_SIG = 0x02014b50;  // Central Directory Header
const LFH_SIG = 0x04034b50;  // Local File Header
const ZIP64_SENTINEL = 0xffffffff;
// A .docx has a handful of entries; a report .zip a few hundred files at most.
// Beyond this we cannot be dealing with a legitimate upload — fail closed rather
// than spend unbounded effort walking a hostile directory.
const MAX_ENTRIES = 65536;

interface InflateBudgetResult {
  ok: boolean;
  totalInflatedBytes: number;
  reason?: string; // set only when ok === false
}

/**
 * Verify that a ZIP/OOXML buffer inflates to no more than `maxTotalBytes` of
 * REAL output, by actually inflating every entry and counting true bytes.
 * Optionally also caps any single entry at `maxEntryBytes`.
 *
 * Returns { ok:true, totalInflatedBytes } when within budget, or
 * { ok:false, reason } when over budget OR unverifiable (fails closed).
 */
function assertZipInflatesWithinBudget(
  buf: Buffer,
  opts: { maxTotalBytes: number; maxEntryBytes?: number }
): InflateBudgetResult {
  const maxTotal = opts.maxTotalBytes;
  const maxEntry = Math.min(opts.maxEntryBytes == null ? maxTotal : opts.maxEntryBytes, maxTotal);

  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, totalInflatedBytes: 0, reason: 'not-a-zip' };
  }

  // Locate the End Of Central Directory record by scanning backward (the ZIP
  // comment can be up to 0xFFFF bytes, so bound the window).
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, totalInflatedBytes: 0, reason: 'no-eocd' };

  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_SENTINEL) return { ok: false, totalInflatedBytes: 0, reason: 'zip64-cd-offset' };
  if (cdOffset + 46 > buf.length) return { ok: false, totalInflatedBytes: 0, reason: 'bad-cd-offset' };
  // The central directory must actually start with a CDH signature. If it does
  // not, we mis-located it (or the archive is crafted) — fail closed rather than
  // treat "zero parseable entries" as an empty, harmless archive (fail open).
  if (buf.readUInt32LE(cdOffset) !== CDH_SIG) {
    return { ok: false, totalInflatedBytes: 0, reason: 'no-central-directory' };
  }

  let off = cdOffset;
  let total = 0;
  let count = 0;

  // Walk the central directory by signature (not by the declared entry count),
  // which is robust to a lying/absent count and to high-entry archives.
  while (off + 46 <= buf.length && buf.readUInt32LE(off) === CDH_SIG) {
    if (++count > MAX_ENTRIES) {
      return { ok: false, totalInflatedBytes: total, reason: 'too-many-entries' };
    }

    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);

    if (localOff === ZIP64_SENTINEL || compSize === ZIP64_SENTINEL) {
      return { ok: false, totalInflatedBytes: total, reason: 'zip64-entry' };
    }

    // Read the LOCAL file header to find where this entry's data really starts.
    // The local header's name/extra lengths can differ from the central
    // directory's, so we must read them from the local header itself.
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LFH_SIG) {
      return { ok: false, totalInflatedBytes: total, reason: 'bad-local-header' };
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart > cdOffset || dataStart > buf.length) {
      return { ok: false, totalInflatedBytes: total, reason: 'bad-data-offset' };
    }

    if (total >= maxTotal && (compSize > 0 || method !== 0)) {
      // Already at the ceiling with more content to come.
      return { ok: false, totalInflatedBytes: total, reason: 'total-exceeds-budget' };
    }

    if (method === 0) {
      // STORED: no compression, so it cannot amplify — the real size equals the
      // stored byte count, which is bounded by the archive itself. Clamp to what
      // actually precedes the central directory so a lying size cannot inflate
      // the count. (We do not trust the declared size for safety; we just tally.)
      const avail = cdOffset - dataStart;
      total += Math.min(compSize, avail < 0 ? 0 : avail);
    } else if (method === 8) {
      // DEFLATE: inflate the REAL stream and count true output bytes. We feed a
      // superset slice (up to the start of the central directory); inflateRaw
      // halts at THIS entry's DEFLATE terminator and ignores trailing bytes
      // (verified behavior), so we never rely on the declared compressed OR
      // uncompressed size. maxOutputLength bounds memory and aborts early.
      const slice = buf.subarray(dataStart, cdOffset);
      const remaining = maxTotal - total;
      const cap = Math.min(maxEntry, remaining);
      try {
        const out = zlib.inflateRawSync(slice, { maxOutputLength: cap > 0 ? cap : 1 });
        if (out.length > cap) {
          return { ok: false, totalInflatedBytes: total + out.length, reason: 'entry-exceeds-budget' };
        }
        total += out.length;
      } catch (e: any) {
        if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
          // Real inflation blew the cap → decompression bomb. Reject.
          return { ok: false, totalInflatedBytes: total, reason: 'entry-exceeds-budget' };
        }
        // Undecodable/corrupt entry — cannot verify, so fail closed.
        return { ok: false, totalInflatedBytes: total, reason: 'inflate-error' };
      }
    } else {
      // Unknown/unsupported compression (bzip2, LZMA, etc.). Legit .docx and
      // report .zip archives only use STORE (0) or DEFLATE (8). Cannot verify a
      // method we do not decode → fail closed.
      return { ok: false, totalInflatedBytes: total, reason: 'unsupported-method-' + method };
    }

    if (total > maxTotal) {
      return { ok: false, totalInflatedBytes: total, reason: 'total-exceeds-budget' };
    }

    off += 46 + nameLen + extraLen + commentLen;
  }

  if (count === 0) {
    // A real ZIP/OOXML always has at least one entry.
    return { ok: false, totalInflatedBytes: 0, reason: 'no-central-directory-entries' };
  }

  return { ok: true, totalInflatedBytes: total };
}

module.exports = { assertZipInflatesWithinBudget };
export {};
