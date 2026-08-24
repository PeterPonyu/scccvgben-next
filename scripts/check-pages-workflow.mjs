#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`Pages workflow contract failed: ${message}`);
};
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const jobBody = (source, name) => {
  const match = source.match(
    new RegExp(`^  ${escapeRegex(name)}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'),
  );
  return match?.[1] ?? '';
};

const validateWorkflow = (source) => {
  const workflowPermissions = source.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
  assert(workflowPermissions.trim() === 'contents: read', 'workflow scope must grant only contents: read.');

  const buildJob = jobBody(source, 'build');
  const deployJob = jobBody(source, 'deploy');
  const deployPermissions = deployJob.match(/^    permissions:\n((?:      .+\n)+)/m)?.[1] ?? '';
  const normalizedDeployPermissions = deployPermissions
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
  assert(normalizedDeployPermissions === 'pages: write\nid-token: write', 'deploy job must grant pages: write and id-token: write.');
  assert(!/^    permissions:/m.test(buildJob), 'build job must not grant deployment permissions.');
  assert(source.includes('source_ref must be a 40-character lowercase commit SHA'), 'immutable source_ref validation must remain.');
  assert(source.includes('repository: PeterPonyu/scCCVGBen'), 'source checkout must remain pinned to scCCVGBen.');
  assert(source.includes('npm run build') && source.includes('npm run check:metadata'), 'build and metadata audit steps must remain.');
  assert(source.includes('actions/upload-pages-artifact@v3') && source.includes('uses: actions/deploy-pages@v4'), 'artifact upload and deployment steps must remain.');
  assert(source.includes('workflow_dispatch:'), 'manual dispatch boundary must remain.');
};

export { validateWorkflow };

const expectRejects = (name, source, message) => {
  try {
    validateWorkflow(source);
  } catch (error) {
    assert(error.message === `Pages workflow contract failed: ${message}.`, `${name} must reject with ${message}`);
    return;
  }
  throw new Error(`Pages workflow self-test failed: ${name} was accepted.`);
};

if (process.argv.includes('--self-test')) {
  const buildPermissionMutation = workflow.replace(
    '  build:\n',
    '  build:\n    permissions:\n      pages: write\n      id-token: write\n',
  );

  validateWorkflow(workflow);
  expectRejects('build job deployment permissions', buildPermissionMutation, 'build job must not grant deployment permissions');
  expectRejects('workflow deployment permissions', workflow.replace('permissions:\n  contents: read', 'permissions:\n  contents: read\n  pages: write'), 'workflow scope must grant only contents: read');
  expectRejects('missing deploy id-token', workflow.replace('      id-token: write\n', ''), 'deploy job must grant pages: write and id-token: write');
  expectRejects('extra deploy contents permission', workflow.replace('      id-token: write\n', '      id-token: write\n      contents: write\n'), 'deploy job must grant pages: write and id-token: write');
} else {
  validateWorkflow(workflow);
  console.log('Pages workflow least-privilege contract passed.');
}
