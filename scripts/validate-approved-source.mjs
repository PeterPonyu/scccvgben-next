#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const shaPattern = /^[0-9a-f]{40}$/;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultAllowlist = join(root, '.github', 'approved-scCCVGBen-source-shas.txt');

const parseAllowlist = (contents) => {
  const approved = new Set();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    if (!shaPattern.test(entry)) {
      throw new Error(`Malformed allowlist entry on line ${index + 1}.`);
    }
    approved.add(entry);
  }
  return approved;
};

const validateApprovedSource = (sourceRef, allowlistContents) => {
  if (!shaPattern.test(sourceRef)) {
    throw new Error('source_ref must be a 40-character lowercase commit SHA.');
  }
  if (!parseAllowlist(allowlistContents).has(sourceRef)) {
    throw new Error('source_ref is not an approved scCCVGBen source revision.');
  }
};

export { parseAllowlist, validateApprovedSource };

const expectRejects = (name, action) => {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`Validator self-test failed: ${name} was accepted.`);
};

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule && process.argv.includes('--self-test')) {
  const approved = '3f1db58802db1638e61e31432db8551bc8b93ed4';
  const alternate = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const allowlist = `# reviewed source\n\n${approved}\n`;

  validateApprovedSource(approved, allowlist);
  expectRejects('unapproved SHA', () => validateApprovedSource(alternate, allowlist));
  expectRejects('uppercase SHA', () => validateApprovedSource(approved.toUpperCase(), allowlist));
  expectRejects('short SHA', () => validateApprovedSource(approved.slice(0, -1), allowlist));
  expectRejects('malformed allowlist entry', () => validateApprovedSource(approved, `${approved}\nmain\n`));
  expectRejects('uppercase allowlist entry', () => validateApprovedSource(approved, `${approved.toUpperCase()}\n`));
  console.log('Approved source validator self-test passed.');
} else if (isMainModule) {
  const [sourceRef, allowlistPath = defaultAllowlist] = process.argv.slice(2);
  if (!sourceRef) {
    throw new Error('Usage: validate-approved-source.mjs <source_ref> [allowlist_path]');
  }
  validateApprovedSource(sourceRef, readFileSync(allowlistPath, 'utf8'));
  console.log(`Approved source revision: ${sourceRef}`);
}
