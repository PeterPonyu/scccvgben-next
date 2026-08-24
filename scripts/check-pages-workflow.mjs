#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseWorkflow = (source, filename) => {
  const directory = mkdtempSync(join(tmpdir(), 'pages-workflow-'));
  const workflowPath = join(directory, filename);
  try {
    writeFileSync(workflowPath, source);
    const result = spawnSync('ruby', ['-e', "require 'yaml'; require 'json'; puts JSON.generate(YAML.safe_load_file(ARGV.fetch(0), permitted_classes: [], permitted_symbols: [], aliases: false))", workflowPath], { encoding: 'utf8' });
    assert(result.status === 0 && result.stdout, `${filename} must parse with Ruby Psych safe YAML parsing.`);
    try {
      const parsed = JSON.parse(result.stdout);
      assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${filename} must be a YAML mapping.`);
      return parsed;
    } catch {
      throw new Error(`Pages workflow contract failed: ${filename} did not produce a safe YAML object.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const workflowOn = (workflow) => workflow.on ?? workflow.true;

const workflowJobs = (workflow, filename) => {
  assert(workflow.jobs && typeof workflow.jobs === 'object' && !Array.isArray(workflow.jobs), `${filename} must define jobs.`);
  return workflow.jobs;
};

const jobSteps = (jobs, jobName, filename) => {
  const steps = jobs[jobName]?.steps;
  assert(Array.isArray(steps), `${filename} jobs.${jobName}.steps must be a sequence.`);
  assert(steps.every((step) => step && typeof step === 'object' && !Array.isArray(step)), `${filename} jobs.${jobName}.steps must contain mappings.`);
  return steps;
};

const validateActionPins = (workflow, source, names, filename) => {
  const allowed = new Set(names.map((name) => `actions/${name}@${pins[name][0]}`));
  const usages = [];
  for (const [jobName, job] of Object.entries(workflowJobs(workflow, filename))) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
    assert(!Object.hasOwn(job, 'uses'), `${filename} jobs.${jobName} must not call a reusable workflow.`);
    if (job.steps === undefined) continue;
    for (const [index, step] of jobSteps(workflowJobs(workflow, filename), jobName, filename).entries()) {
      if (!Object.hasOwn(step, 'uses')) continue;
      assert(typeof step.uses === 'string', `${filename} jobs.${jobName}.steps[${index}].uses must be a string.`);
      usages.push({ jobName, index, uses: step.uses });
    }
  }
  assert(usages.length > 0, 'workflows must use pinned actions.');
  for (const name of names) {
    const approvedUse = `actions/${name}@${pins[name][0]}`;
    const parsedCount = usages.filter(({ uses }) => uses === approvedUse).length;
    const documentedCount = (source.match(new RegExp(`^\\s*uses:\\s*${escapeRegExp(approvedUse)}\\s+#\\s*${escapeRegExp(pins[name][1])}\\s*$`, 'gm')) ?? []).length;
    assert(parsedCount > 0, `actions/${name} must use its approved immutable pin.`);
    assert(documentedCount === parsedCount, `each actions/${name} use must carry its human version comment.`);
  }
  for (const { uses } of usages) {
    assert(allowed.has(uses), `mutable or unknown action reference is forbidden: ${uses}.`);
  }
};

const validatePagesWorkflow = (source, allowlist) => {
  const workflow = parseWorkflow(source, 'pages.yml');
  const jobs = workflowJobs(workflow, 'pages.yml');
  const buildSteps = jobSteps(jobs, 'build', 'pages.yml');
  const workflowPermissions = source.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
  assert(workflowPermissions.trim() === 'contents: read', 'workflow scope must grant only contents: read.');
  assert(workflow.permissions?.contents === 'read' && Object.keys(workflow.permissions).length === 1, 'workflow scope must grant only contents: read.');
  assert(jobs.deploy?.permissions?.pages === 'write' && jobs.deploy?.permissions?.['id-token'] === 'write' && Object.keys(jobs.deploy?.permissions ?? {}).length === 2, 'deploy job must grant pages: write and id-token: write.');
  assert(!jobs.build.permissions, 'build job must not grant deployment permissions.');
  assert(workflowOn(workflow)?.workflow_dispatch !== undefined, 'manual dispatch boundary must remain.');
  const [deploymentCheckout, validator, sourceCheckout] = buildSteps;
  assert(deploymentCheckout?.uses === `actions/checkout@${pins.checkout[0]}`, 'first build step must check out the deployment repository with the approved checkout SHA.');
  assert(deploymentCheckout.with?.['persist-credentials'] === false, 'deployment checkout must disable credential persistence.');
  assert(!Object.hasOwn(deploymentCheckout.with ?? {}, 'repository') && !Object.hasOwn(deploymentCheckout.with ?? {}, 'ref'), 'deployment checkout must not select a source repository or ref.');
  assert(!Object.hasOwn(validator ?? {}, 'uses') && validator?.env?.SOURCE_REF === '${{ inputs.source_ref }}' && validator?.run?.trim() === 'node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'second build step must run the provenance validator with SOURCE_REF.');
  assert(sourceCheckout?.uses === `actions/checkout@${pins.checkout[0]}`, 'third build step must check out the source with the approved checkout SHA.');
  assert(sourceCheckout.with?.repository === 'PeterPonyu/scCCVGBen' && sourceCheckout.with?.ref === '${{ inputs.source_ref }}' && sourceCheckout.with?.['persist-credentials'] === false, 'source checkout must use the validated immutable input SHA without persisted credentials.');
  assert(!source.includes('awk -v source_ref'), 'fail-open inline allowlist guards are forbidden.');
  assert(source.includes('npm run build') && source.includes('npm run check:metadata'), 'build and metadata audit steps must remain.');
  validateActionPins(workflow, source, ['checkout', 'setup-node', 'configure-pages', 'upload-pages-artifact', 'deploy-pages'], 'pages.yml');

  const parsed = parseAllowlist(allowlist);
  assert(parsed.size === 1 && parsed.has(approvedSource), 'reviewed rollout source SHA must remain the sole approved source.');
};

const validateValidationWorkflow = (source) => {
  const workflow = parseWorkflow(source, 'pages-validation.yml');
  const workflowPermissions = source.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
  assert(workflowPermissions.trim() === 'contents: read', 'validation workflow must grant only contents: read.');
  assert(workflow.permissions?.contents === 'read' && Object.keys(workflow.permissions).length === 1, 'validation workflow must grant only contents: read.');
  assert(Array.isArray(workflowOn(workflow)?.pull_request?.branches) && workflowOn(workflow).pull_request.branches.length === 1 && workflowOn(workflow).pull_request.branches[0] === 'gh-pages', 'validation workflow must trigger pull requests targeting gh-pages.');
  for (const path of ['.github/workflows/pages.yml', '.github/workflows/pages-validation.yml', '.github/approved-scCCVGBen-source-shas.txt', 'scripts/check-pages-workflow.mjs', 'scripts/validate-approved-source.mjs']) {
    assert(source.includes(`- '${path}'`), `validation workflow must watch ${path}.`);
  }
  assert(source.includes('node scripts/check-pages-workflow.mjs\n') && source.includes('node scripts/check-pages-workflow.mjs --self-test'), 'validation workflow must run checker and checker self-test.');
  assert(source.includes('node scripts/validate-approved-source.mjs --self-test'), 'validation workflow must run validator self-test.');
  assert(source.includes('node --check scripts/check-pages-workflow.mjs') && source.includes('node --check scripts/validate-approved-source.mjs'), 'validation workflow must syntax-check both scripts.');
  assert(source.includes('.github/workflows/pages.yml .github/workflows/pages-validation.yml'), 'validation workflow must parse both workflow YAML files.');
  const validationSteps = jobSteps(workflowJobs(workflow, 'pages-validation.yml'), 'validate', 'pages-validation.yml');
  assert(validationSteps[0]?.uses === `actions/checkout@${pins.checkout[0]}` && validationSteps[0].with?.['persist-credentials'] === false, 'validation checkout must disable credential persistence.');
  validateActionPins(workflow, source, ['checkout', 'setup-node'], 'pages-validation.yml');
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
  expectRejects('no-op validator command with an expected-command comment', () => validateWorkflows(pagesWorkflow.replace('run: node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'run: : # node scripts/validate-approved-source.mjs "$SOURCE_REF"'), validationWorkflow, approvedSources));
  expectRejects('forged step labels cannot mask source checkout before validation', () => validateWorkflows(pagesWorkflow.replace('name: Deploy scCCVGBen GitHub Pages', 'name: Deploy scCCVGBen GitHub Pages\n# name: Checkout deployment repository\n# name: Validate immutable source revision\n# name: Checkout scCCVGBen source revision').replace(`      - name: Checkout deployment repository\n        ${action('checkout')}\n        with:\n          persist-credentials: false\n\n      - name: Validate immutable source revision\n        env:\n          SOURCE_REF: \${{ inputs.source_ref }}\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"\n\n      - name: Checkout scCCVGBen source revision\n        ${action('checkout')}\n        with:\n          repository: PeterPonyu/scCCVGBen\n          ref: \${{ inputs.source_ref }}\n          persist-credentials: false`, `      - name: Checkout scCCVGBen source revision\n        ${action('checkout')}\n        with:\n          repository: PeterPonyu/scCCVGBen\n          ref: \${{ inputs.source_ref }}\n          persist-credentials: false\n\n      - name: Checkout deployment repository\n        ${action('checkout')}\n        with:\n          persist-credentials: false\n\n      - name: Validate immutable source revision\n        env:\n          SOURCE_REF: \${{ inputs.source_ref }}\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"`), validationWorkflow, approvedSources));
  expectRejects('untrusted action tag', () => validateWorkflows(pagesWorkflow.replace(action('setup-node'), 'uses: attacker/untrusted-action@v1 # v1'), validationWorkflow, approvedSources));
  expectRejects('unknown action immutable SHA', () => validateWorkflows(pagesWorkflow.replace(action('setup-node'), 'uses: attacker/untrusted-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa # v1'), validationWorkflow, approvedSources));
  expectRejects('reusable workflow action', () => validateWorkflows(`${pagesWorkflow}\n  evil:\n    uses: attacker/untrusted-action@v1\n`, validationWorkflow, approvedSources));
  expectRejects('unrelated action comment cannot document an executable use', () => validateWorkflows(`${pagesWorkflow.replace(action('setup-node'), `uses: actions/setup-node@${pins['setup-node'][0]}`)}\n# ${action('setup-node')}\n`, validationWorkflow, approvedSources));
  expectRejects('validator rejects unapproved source', () => validateApprovedSource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', approvedSources));
  expectRejects('validator rejects malformed allowlist', () => validateApprovedSource(approvedSource, `${approvedSource}\nmain\n`));
  console.log('Pages workflow checker self-test passed.');
} else {
  validateWorkflows(pagesWorkflow, validationWorkflow, approvedSources);
  console.log('Pages workflow contracts passed.');
}
