import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const root = path.resolve(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/deploy-s3.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const syncCmd = wf.slice(wf.indexOf('aws s3 sync'));
const excludes = [...syncCmd.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]);

// Mimics aws s3 --exclude globbing (fnmatch, * matches across '/').
const excluded = (rel: string) =>
  excludes.some((g) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(rel));

const walk = (dir: string, out: string[] = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'test-results') continue;
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(p, out) : out.push(path.relative(root, p));
  }
  return out;
};

test('deploy workflow triggers on push to master and workflow_dispatch', () => {
  expect(wf).toMatch(/push:\s*\n\s*branches:\s*\n\s*- master/);
  expect(wf).toMatch(/workflow_dispatch:/);
  expect(wf).toMatch(/concurrency:/);
});

test('deploy workflow has no hardcoded bucket, region, account or credentials', () => {
  expect(wf).toContain('${{ vars.S3_BUCKET }}');
  expect(wf).toContain('${{ vars.AWS_REGION }}');
  expect(wf).toContain('${{ secrets.AWS_ROLE_ARN }}');
  expect(wf).not.toMatch(/AKIA[0-9A-Z]{12,}/);
  expect(wf).not.toMatch(/arn:aws:iam::\d{12}/);
  expect(wf).not.toMatch(/\b\d{12}\b/);
  expect(wf).not.toMatch(/(eu|us|ap|sa|ca|me|af)-[a-z]+-\d/);
  expect(wf).not.toMatch(/s3:\/\/(?!\$)/);
});

test('sync uploads every asset referenced by index.html', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="((?:css|js|vendor|img)\/[^"#?]+|cv\.pdf)"/g)].map((m) => m[1]);
  expect(refs.length).toBeGreaterThan(0);
  for (const r of ['css/creative.min.css', 'js/creative.min.js', 'cv.pdf', 'index.html']) {
    expect(fs.existsSync(path.join(root, r))).toBe(true);
    expect(excluded(r)).toBe(false);
  }
  for (const r of refs) {
    if (fs.existsSync(path.join(root, r))) expect(excluded(r), r).toBe(false);
  }
  const files = walk(root);
  expect(files.some((f) => f.startsWith('vendor/') && !excluded(f))).toBe(true);
  expect(files.some((f) => f.startsWith('img/') && !excluded(f))).toBe(true);
});

test('sync excludes .git, .github and scss and uses --delete', () => {
  expect(syncCmd).toContain('--delete');
  for (const f of ['.git/config', '.github/workflows/deploy-s3.yml', 'scss/creative.scss']) {
    expect(excluded(f), f).toBe(true);
  }
  for (const f of walk(root).filter((f) => f.startsWith('scss/') || f.startsWith('.github/'))) {
    expect(excluded(f), f).toBe(true);
  }
});

test('README documents variables, secret and IAM permissions', () => {
  for (const s of ['S3_BUCKET', 'AWS_REGION', 'AWS_ROLE_ARN', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject', 'Run workflow']) {
    expect(readme).toContain(s);
  }
});
