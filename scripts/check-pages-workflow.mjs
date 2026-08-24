#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(`Pages workflow contract failed: ${message}`);
};

const workflowPermissions = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? '';
assert(workflowPermissions.trim() === 'contents: read', 'workflow scope must grant only contents: read.');

const deployJob = workflow.match(/^  deploy:\n([\s\S]*)$/m)?.[1] ?? '';
assert(/\n    permissions:\n      pages: write\n      id-token: write\n/.test(deployJob), 'deploy job must grant pages: write and id-token: write.');
assert(!/^  build:[\s\S]*?^  permissions:/m.test(workflow), 'build job must not grant deployment permissions.');
assert(workflow.includes('source_ref must be a 40-character lowercase commit SHA'), 'immutable source_ref validation must remain.');
assert(workflow.includes('repository: PeterPonyu/scCCVGBen'), 'source checkout must remain pinned to scCCVGBen.');
assert(workflow.includes('npm run build') && workflow.includes('npm run check:metadata'), 'build and metadata audit steps must remain.');
assert(workflow.includes('actions/upload-pages-artifact@v3') && workflow.includes('uses: actions/deploy-pages@v4'), 'artifact upload and deployment steps must remain.');
assert(workflow.includes('workflow_dispatch:'), 'manual dispatch boundary must remain.');

console.log('Pages workflow least-privilege contract passed.');
