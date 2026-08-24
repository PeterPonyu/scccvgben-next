#!/usr/bin/env node

import assert from 'node:assert/strict';
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

const rubyParser = String.raw`
require 'yaml'
require 'json'
def inspect_node(node, top = false)
  raise 'YAML aliases are forbidden' if node.is_a?(Psych::Nodes::Alias)
  case node
  when Psych::Nodes::Mapping
    seen = {}
    node.children.each_slice(2) do |key, value|
      raise 'mapping has an incomplete entry' unless key && value
      raise 'mapping keys must be scalars' unless key.is_a?(Psych::Nodes::Scalar)
      raise "duplicate mapping key: #{key.value}" if seen[key.value]
      seen[key.value] = true
      inspect_node(value)
    end
    raise 'top-level key on must appear exactly once and be literal' unless !top || seen['on']
  when Psych::Nodes::Sequence
    node.children.each { |child| inspect_node(child) }
  when Psych::Nodes::Scalar
  else
    raise "unexpected YAML AST node: #{node.class}"
  end
end
document = YAML.parse_file(ARGV.fetch(0))
raise 'workflow must have a document root' unless document && document.root
raise 'workflow root must be a mapping' unless document.root.is_a?(Psych::Nodes::Mapping)
inspect_node(document.root, true)
puts JSON.generate(YAML.safe_load_file(ARGV.fetch(0), permitted_classes: [], permitted_symbols: [], aliases: false))
`;

const contractError = (filename, message) => new Error(`Pages workflow contract failed: ${filename}: ${message}`);
const parseWorkflow = (source, filename) => {
  const directory = mkdtempSync(join(tmpdir(), 'pages-workflow-'));
  const workflowPath = join(directory, filename);
  try {
    writeFileSync(workflowPath, source);
    const result = spawnSync('ruby', ['-e', rubyParser, workflowPath], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) throw contractError(filename, `safe AST-gated YAML parsing failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
    const workflow = JSON.parse(result.stdout);
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw contractError(filename, 'must be a YAML mapping.');
    // Psych's YAML 1.1 compatibility coerces unquoted `on` to boolean true.
    // The AST check above proves the original top-level token was literally `on`.
    if (Object.hasOwn(workflow, 'true')) {
      if (Object.hasOwn(workflow, 'on')) throw contractError(filename, 'cannot contain both on and true keys.');
      workflow.on = workflow.true;
      delete workflow.true;
    }
    return workflow;
  } catch (error) {
    if (error instanceof SyntaxError) throw contractError(filename, 'did not produce JSON.');
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const use = (name) => `actions/${name}@${pins[name][0]}`;
const pagesExpected = {
  name: 'Deploy scCCVGBen GitHub Pages',
  on: { workflow_dispatch: { inputs: { source_ref: { description: '40-character scCCVGBen source commit SHA', required: true, type: 'string' } } } },
  permissions: { contents: 'read' }, concurrency: { group: 'pages', 'cancel-in-progress': false },
  jobs: {
    build: { 'runs-on': 'ubuntu-latest', steps: [
      { name: 'Checkout deployment repository', uses: use('checkout'), with: { 'persist-credentials': false } },
      { name: 'Validate immutable source revision', env: { SOURCE_REF: '${{ inputs.source_ref }}' }, run: 'node scripts/validate-approved-source.mjs "$SOURCE_REF"' },
      { name: 'Checkout scCCVGBen source revision', uses: use('checkout'), with: { repository: 'PeterPonyu/scCCVGBen', ref: '${{ inputs.source_ref }}', 'persist-credentials': false } },
      { name: 'Setup Node 20', uses: use('setup-node'), with: { 'node-version': '20', cache: 'npm', 'cache-dependency-path': 'webapp/package-lock.json' } },
      { name: 'Install dependencies', 'working-directory': 'webapp', run: 'npm ci' },
      { name: 'Lint', 'working-directory': 'webapp', run: 'npm run lint' },
      { name: 'Build static export with public base path', 'working-directory': 'webapp', env: { NEXT_PUBLIC_BASE_PATH: '/scccvgben-next' }, run: 'npm run build' },
      { name: 'Audit rendered site metadata', 'working-directory': 'webapp', run: 'npm run check:metadata' },
      { name: 'Configure Pages', uses: use('configure-pages') },
      { name: 'Upload Pages artifact', uses: use('upload-pages-artifact'), with: { path: 'webapp/out' } },
    ] },
    deploy: { needs: 'build', environment: { name: 'github-pages', url: '${{ steps.deployment.outputs.page_url }}' }, 'runs-on': 'ubuntu-latest', permissions: { pages: 'write', 'id-token': 'write' }, steps: [{ name: 'Deploy to GitHub Pages', id: 'deployment', uses: use('deploy-pages') }] },
  },
};
const validationExpected = {
  name: 'Validate scCCVGBen Pages workflow',
  on: { pull_request: { branches: ['gh-pages'], paths: ['.github/workflows/pages.yml', '.github/workflows/pages-validation.yml', '.github/approved-scCCVGBen-source-shas.txt', 'scripts/check-pages-workflow.mjs', 'scripts/validate-approved-source.mjs'] } },
  permissions: { contents: 'read' },
  jobs: { validate: { 'runs-on': 'ubuntu-latest', steps: [
    { name: 'Checkout pull request', uses: use('checkout'), with: { 'persist-credentials': false } },
    { name: 'Setup Node 20', uses: use('setup-node'), with: { 'node-version': '20' } },
    { name: 'Run workflow checker and self-test', run: 'node scripts/check-pages-workflow.mjs\nnode scripts/check-pages-workflow.mjs --self-test\nnode scripts/validate-approved-source.mjs --self-test\n' },
    { name: 'Check JavaScript syntax', run: 'node --check scripts/check-pages-workflow.mjs\nnode --check scripts/validate-approved-source.mjs\n' },
    { name: 'Parse workflow YAML', run: 'ruby -e "require \'yaml\'; ARGV.each { |path| YAML.parse_file(path) }" .github/workflows/pages.yml .github/workflows/pages-validation.yml' },
  ] } },
};
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const assertVersionComments = (source, expected, filename) => {
  for (const [name, [sha, version]] of Object.entries(pins)) {
    const expectedCount = JSON.stringify(expected).split(`actions/${name}@${sha}`).length - 1;
    const line = new RegExp(`^\\s*uses:\\s*${escapeRegExp(`actions/${name}@${sha}`)}\\s+#\\s*${escapeRegExp(version)}\\s*$`, 'gm');
    assert.equal((source.match(line) ?? []).length, expectedCount, contractError(filename, `actions/${name} must have exactly ${expectedCount} executable SHA + version-comment lines.`));
  }
};
const validateWorkflows = (pages, validation, allowlist) => {
  const parsedPages = parseWorkflow(pages, 'pages.yml');
  const parsedValidation = parseWorkflow(validation, 'pages-validation.yml');
  assert.deepStrictEqual(parsedPages, pagesExpected, contractError('pages.yml', 'does not match the closed canonical schema.'));
  assert.deepStrictEqual(parsedValidation, validationExpected, contractError('pages-validation.yml', 'does not match the closed canonical schema.'));
  assertVersionComments(pages, pagesExpected, 'pages.yml');
  assertVersionComments(validation, validationExpected, 'pages-validation.yml');
  assert.deepStrictEqual(parseAllowlist(allowlist), new Set([approvedSource]), 'Pages workflow contract failed: rollout source SHA must remain the sole approved source.');
};
export { validateWorkflows };
const expectRejects = (name, action) => { try { action(); } catch { return; } throw new Error(`Pages workflow self-test failed: ${name} was accepted.`); };
if (process.argv.includes('--self-test')) {
  validateWorkflows(pagesWorkflow, validationWorkflow, approvedSources);
  const pages = (transform) => () => validateWorkflows(transform(pagesWorkflow), validationWorkflow, approvedSources);
  const validation = (transform) => () => validateWorkflows(pagesWorkflow, transform(validationWorkflow), approvedSources);
  expectRejects('fail-open provenance guard', pages((s) => s.replace('node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'true')));
  expectRejects('removed provenance enforcement', pages((s) => s.replace('node scripts/validate-approved-source.mjs "$SOURCE_REF"', '')));
  expectRejects('validator if false', pages((s) => s.replace('run: node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'if: false\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"')));
  expectRejects('validator continue-on-error', pages((s) => s.replace('run: node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'continue-on-error: true\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"')));
  expectRejects('validator working directory', pages((s) => s.replace('run: node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'working-directory: /tmp\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"')));
  expectRejects('validator shell', pages((s) => s.replace('run: node scripts/validate-approved-source.mjs "$SOURCE_REF"', 'shell: bash\n        run: node scripts/validate-approved-source.mjs "$SOURCE_REF"')));
  expectRejects('validator NODE_OPTIONS', pages((s) => s.replace('SOURCE_REF: ${{ inputs.source_ref }}', 'SOURCE_REF: ${{ inputs.source_ref }}\n          NODE_OPTIONS: --require ./evil.js')));
  expectRejects('workflow defaults', pages((s) => s.replace('jobs:', 'defaults:\n  run:\n    working-directory: /tmp\njobs:')));
  expectRejects('build defaults', pages((s) => s.replace('    runs-on: ubuntu-latest\n    steps:', '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: /tmp\n    steps:')));
  expectRejects('source checkout path', pages((s) => s.replace('          persist-credentials: false\n\n      - name: Setup Node 20', '          persist-credentials: false\n          path: source\n\n      - name: Setup Node 20')));
  expectRejects('extra exfiltrate job', pages((s) => `${s}\n  exfiltrate:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n      - run: curl https://example.invalid\n`));
  expectRejects('no-op build metadata comment', pages((s) => s.replace('run: npm run check:metadata', 'run: : # npm run check:metadata')));
  expectRejects('no-op validation checker comment', validation((s) => s.replace('node scripts/check-pages-workflow.mjs\n', ': # node scripts/check-pages-workflow.mjs\n')));
  expectRejects('weakened validation trigger', validation((s) => s.replace('pull_request:', 'push:')));
  expectRejects('weakened validation branch', validation((s) => s.replace('branches: [gh-pages]', 'branches: [main]')));
  expectRejects('weakened validation permissions', validation((s) => s.replace('contents: read', 'contents: write')));
  expectRejects('absent validator self-test', validation((s) => s.replace('node scripts/validate-approved-source.mjs --self-test\n', '')));
  expectRejects('on coerced to yes', pages((s) => s.replace(/^on:/m, 'yes:')));
  expectRejects('on coerced to true', pages((s) => s.replace(/^on:/m, 'true:')));
  expectRejects('detached version comment', pages((s) => `${s.replace(' # v4', '')}\n# uses: actions/checkout@${pins.checkout[0]} # v4\n`));
  expectRejects('duplicate steps key', pages((s) => s.replace('    steps:', '    steps: []\n    steps:')));
  expectRejects('extra step', pages((s) => s.replace('      - name: Configure Pages', '      - name: Exfiltrate\n        run: curl https://example.invalid\n\n      - name: Configure Pages')));
  expectRejects('changed deploy permissions', pages((s) => s.replace('      pages: write', '      pages: read')));
  expectRejects('unapproved-only allowlist', () => validateWorkflows(pagesWorkflow, validationWorkflow, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'));
  expectRejects('malformed allowlist', () => validateWorkflows(pagesWorkflow, validationWorkflow, `${approvedSource}\nmain\n`));
  expectRejects('mutable action tag', pages((s) => s.replace(pins.checkout[0], 'v4')));
  expectRejects('mutable validation action tag', validation((s) => s.replace(pins['setup-node'][0], 'v4')));
  expectRejects('untrusted action', pages((s) => s.replace(use('setup-node'), 'attacker/untrusted-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')));
  expectRejects('unknown action immutable SHA', pages((s) => s.replace(use('setup-node'), 'attacker/untrusted-action@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')));
  expectRejects('reusable workflow', pages((s) => `${s}\n  evil:\n    uses: attacker/untrusted-action@v1\n`));
  expectRejects('forged labels and reordered source checkout', pages((s) => s.replace('      - name: Checkout deployment repository', '      - name: Checkout scCCVGBen source revision')));
  expectRejects('unrelated action comment', pages((s) => `${s.replace(' # v4', '')}\n# uses: actions/checkout@${pins.checkout[0]} # v4\n`));
  expectRejects('validator rejects unapproved source', () => validateApprovedSource('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', approvedSources));
  expectRejects('validator rejects malformed allowlist', () => validateApprovedSource(approvedSource, `${approvedSource}\nmain\n`));
  console.log('Pages workflow checker self-test passed.');
} else { validateWorkflows(pagesWorkflow, validationWorkflow, approvedSources); console.log('Pages workflow contracts passed.'); }
