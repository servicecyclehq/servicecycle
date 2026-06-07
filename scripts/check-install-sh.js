#!/usr/bin/env node
/**
 * check-install-sh.js
 *
 * Lightweight syntax sanity check for scripts/install.sh that doesn't
 * depend on having bash on the PATH (Windows operators, Cowork sandbox
 * with stale mounts, etc.).
 *
 * What it checks:
 *   1. Heredoc balance — every `<<DELIM` (or `<<-DELIM`) has a matching
 *      line that is exactly `DELIM` (or `<TAB>*DELIM` for <<-) with
 *      nothing else on it.
 *   2. Quoted heredocs are honoured: `<<'DELIM'` and `<<"DELIM"` strip
 *      the quotes when matching the closer.
 *   3. The final line is not an unclosed heredoc.
 *   4. No CRLF line endings (heredoc closers don't match if "EOF" has a
 *      trailing \r).
 *
 * What it does NOT check: full bash semantics. For real validation,
 * run `bash -n` on Linux / macOS / WSL.
 *
 * Exit codes:
 *   0  — looks OK
 *   1  — heredoc imbalance, CRLF endings, or other detected issue
 *   2  — file missing
 *
 * Usage:
 *   node scripts/check-install-sh.js                   # default path
 *   node scripts/check-install-sh.js path/to/install.sh
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, 'install.sh');

if (!fs.existsSync(target)) {
  console.error(`error: file not found: ${target}`);
  process.exit(2);
}

const raw = fs.readFileSync(target, 'utf8');

// ── Check 1: CRLF endings ───────────────────────────────────────────────────
if (raw.includes('\r')) {
  console.error(`✗ ${target}: contains CRLF line endings — bash heredoc closers won't match against "EOF\\r".`);
  console.error('  Fix: re-save with LF line endings (git config core.autocrlf input on Windows).');
  process.exit(1);
}

const lines = raw.split('\n');

// ── Check 2: heredoc balance ────────────────────────────────────────────────
// Track an open-heredoc stack: { delim, allowIndent, lineNo }.
// Match opener via <<DELIM or <<-DELIM, with optional quoting around DELIM.
// Don't try to be perfect about quoting + escaping — install.sh uses
// simple, conventional heredocs.
const openers = []; // stack
const HEREDOC_RE = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const lineNo = i + 1;

  // If we're inside a heredoc, only the closer matters.
  if (openers.length > 0) {
    const top = openers[openers.length - 1];
    const closer = top.allowIndent ? line.replace(/^[\t]+/, '') : line;
    if (closer === top.delim) {
      openers.pop();
      continue;
    }
    // Otherwise, it's body text — ignore for syntax purposes.
    continue;
  }

  // Not inside a heredoc — look for new openers on this line. There can
  // be more than one on a single line (rare but legal: `cmd <<E1; cmd2 <<E2`).
  // Strip line comments first so a `# <<EOF` in a comment doesn't open a
  // phantom heredoc.
  const codeOnly = line.replace(/(^|[^\\])#.*$/, '$1');

  let m;
  HEREDOC_RE.lastIndex = 0;
  while ((m = HEREDOC_RE.exec(codeOnly)) !== null) {
    openers.push({
      delim:       m[3],
      allowIndent: m[1] === '-',
      lineNo,
    });
  }
}

if (openers.length > 0) {
  console.error(`✗ ${target}: ${openers.length} unclosed heredoc(s) at end of file:`);
  for (const o of openers) {
    console.error(`    line ${o.lineNo}: <<${o.allowIndent ? '-' : ''}${o.delim} (no matching closer)`);
  }
  process.exit(1);
}

// ── Check 3: final blank-line discipline (defensive — catches accidental
//             EOF stripping that sometimes happens with copy/paste). ────────
const trailing = raw.replace(/\s+$/, '').length;
if (trailing === 0) {
  console.error(`✗ ${target}: file is empty after stripping whitespace.`);
  process.exit(1);
}

console.log(`✓ ${target}: ${lines.length} lines, no heredoc imbalance, no CRLF — looks structurally OK.`);
console.log('  Note: this is a structural check only, not full bash semantics.');
process.exit(0);
