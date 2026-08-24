#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAllowlist, validateApprovedSource } from './validate-approved-source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pagesWorkflow = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const validationWorkflow = readFileSync(join(root, '.github', 'workflows', 'pages-validation.yml'), 'utf8');
const approvedSources = readFileSync(join(root, '.github', 'approved-scCCVGBen-source-shas.txt'), 'utf8');
const approvedSource = '3f1db58802db1638e61e31432db8551bc8b93ed4';

const pins = {
  checkout: ['11d5960a326750d5838078e36cf38b85af677262', 'v4'],
  'setup-node': ['49933ea5288caeca8642d1e84afbd3f7d6820020', 'v4'],
  'configure-pages': ['983d7736d9b0ae728b81ab479565c72886d7745b', 'v5'],
  'upload-pages-artifact': ['56afc609e74202658d3ffba0e8f6dda462b719fa', 'v3'],
  'deploy-pages': ['d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e', 'v4'],
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`Pages workflow contract failed: ${message}`);
};
const action = (name) => `uses: actions/${name}@${pins[name][0]} # ${pins[name][1]}`;

const jobBody = (source, name) => {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  return match?.[1] ?? '';
};

const validateActionPins = (source, names) => {
  const usages = source.match(/^\s*uses:\s*actions\/[^\s]+.*$/gm) ?? [];
  assert(usages.length > 0, 'workflows must use pinned actions.');
  for (const name of names) {
    assert(source.includes(action(name)), `actions/${name} must use its immutable pin with a human version comment.`);
  }
  for (const usage of usages) {
    assert(Object.keys(pins).some((name) => usage.trim() === action(name)), `mutable or unknown action reference is forbidden: ${usage.trim()}.`);
  }
};

const validatePagesWorkflow = (source, allowlist) => {
  const workflowPermissions = source.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
  assert(workflowPermissions.trim() === 'contents: read', 'workflow scope must grant only contents: read.');
  const buildJob = jobBody(source, 'build');
  const deployJob = jobBody(source, 'deploy');
  const deployPermissions = deployJob.match(/^    permissions:\n((?:      .+\n)+)/m)?.[1] ?? '';
  const normalizedDeployPermissions = deployPermissions.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  assert(normalizedDeployPermissions === 'pages: write\nid-token: write', 'deploy job must grant pages: write and id-token: write.');
  assert(!/^    permissions:/m.test(buildJob), 'build job must not grant deployment permissions.');
  assert(source.includes('workflow_dispatch:'), 'manual dispatch boundary must remain.');
  assert(source.includes('repository: PeterPonyu/scCCVGBen'), 'source checkout must remain pinned to scCCVGBen.');
  assert(source.includes('ref: ${{ inputs.source_ref }}'), 'source checkout must use the validated immutable input SHA.');
  assert(source.includes('node scripts/validate-approved-source.mjs "$SOURCE_REF"'), 'executable provenance validator must remain.');
  assert(!source.includes('awk -v source_ref'), 'fail-open inline allowlist guards are forbidden.');
  assert(source.includes('npm run build') && source.includes('npm run check:metadata'), 'build and metadata audit steps must remain.');
  assert(source.includes('persist-credentials: false'), 'checkouts must not persist credentials.');
  validateActionPins(source, ['checkout', 'setup-node', 'configure-pages', 'upload-pages-artifact', 'deploy-pages']);

  const deploymentCheckout = source.indexOf('name: Checkout deployment repository');
  const validator = source.indexOf('name: Validate immutable source revision');
  const sourceCheckout = source.indexOf('name: Checkout scCCVGBen source revision');
  assert(deploymentCheckout >= 0 && deploymentCheckout < validator && validator < sourceCheckout, 'deployment checkout must precede validation, which must precede source checkout.');
  assert(source.includes(`${action('checkout')}\n        with:\n          persist-credentials: false`), 'initial deployment checkout must disable credential persistence.');

  const parsed = parseAllowlist(allowlist);
  assert(parsed.size === 1 && parsed.has(approvedSource), 'reviewed rollout source SHA must remain the sole approved source.');
};

const validateValidationWorkflow = (source) => {
  const workflowPermissions = source.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
  assert(workflowPermissions.trim() === 'contents: read', 'validation workflow must grant only contents: read.');
  assert(/on:\n  pull_request:\n    branches: \[gh-pages\]/.test(source), 'validation workflow must trigger pull requests targeting gh-pages.');
  for (const path of ['.github/workflows/pages.yml', '.github/workflows/pages-validation.yml', '.github/approved-scCCVGBen-source-shas.txt', 'scripts/check-pages-workflow.mjs', 'scripts/validate-approved-source.mjs']) {
    assert(source.includes(`- '${path}'`), `validation workflow must watch ${path}.`);
  }
  assert(source.includes('node scripts/check-pages-workflow.mjs\n') && source.includes('node scripts/check-pages-workflow.mjs --self-test'), 'validation workflow must run checker and checker self-test.');
  assert(source.includes('node scripts/validate-approved-source.mjs --self-test'), 'validation workflow must run validator self-test.');
  assert(source.includes('node --check scripts/check-pages-workflow.mjs') && source.includes('node --check scripts/validate-approved-source.mjs'), 'validation workflow must syntax-check both scripts.');
  assert(source.includes('.github/workflows/pages.yml .github/workflows/pages-validation.yml'), 'validation workflow must parse both workflow YAML files.');
  assert(source.includes(`${action('checkout')}\n        with:\n          persist-credentials: false`), 'validation checkout must disable credential persistence.');
  validateActionPins(source, ['checkout', 'setup-node']);
};

const validateWorkflows = (pages, validation, allowlist) => {
  validatePagesWorkflow(pages, allowlist);
  validateValidationWorkflow(validation);
};

export { validateWorkflows };

const expectRejects = (name, action) => {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`Pages workflow self-test failed: ${name} was accepted.`);
};

if (process.argv.includes('--self-test')) {
  validateWorkflows(pagesWorkflow, validationWorkflow, approvedSources);
  expectRejects('fail-open provenance guard', () => validateWorkflows(pagesWorkflow.replace('node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'true'), validationWorkflow, approvedSources));
  expectRejects('removed provenance enforcement', () => validateWorkflows(pagesWorkflow.replace('node scripts/validate-approved-source.mjs "$SOURCE_REF"', ''), validationWorkflow, approvedSources));
  expectRejects('unapproved-only allowlist', () => validateWorkflows(pagesWorkflow, validationWorkflow, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
  expectRejects('malformed allowlist', () => validateWorkflows(pagesWorkflow, validationWorkflow, `${approvedSource}\nmain\n`));
  expectRejects('weakened validation trigger', () => validateWorkflows(pagesWorkflow, validationWorkflow.replace('pull_request:', 'push:'), approvedSources));
  expectRejects('weakened validation branch', () => validateWorkflows(pagesWorkflow, validationWorkflow.replace('branches: [gh-pages]', 'branches: [main]'), approvedSources));
  expectRejects('weakened validation permissions', () => validateWorkflows(pagesWorkflow, validationWorkflow.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'), approvedSources));
  expectRejects('absent validator command', () => validateWorkflows(pagesWorkflow, validationWorkflow.replace('          node scripts/validate-approved-source.mjs --self-test\n', ''), approvedSources));
  expectRejects('mutable action tag', () => validateWorkflows(pagesWorkflow.replace(pins.checkout[0], 'v4'), validationWorkflow, approvedSources));
  expectRejects('mutable validation action tag', () => validateWorkflows(pagesWorkflow, validationWorkflow.replace(pins['setup-node'][0], 'v4'), approvedSources));
  expectRejects('validator rejects unapproved source', () => validateApprovedSource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', approvedSources));
  expectRejects('validator rejects malformed allowlist', () => validateApprovedSource(approvedSource, `${approvedSource}\nmain\n`));
  console.log('Pages workflow checker self-test passed.');
} else {
  validateWorkflows(pagesWorkflow, validationWorkflow, approvedSources);
  console.log('Pages workflow contracts passed.');
}
