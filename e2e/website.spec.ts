import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const artifacts = process.env.QA_ARTIFACTS_DIR;
const pageUrl = 'file://' + path.resolve(__dirname, '..', 'index.html');
const shot = async (page: any, name: string) => {
  if (artifacts) {
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, name) });
  }
};
const pause = (page: any, ms = 1000) => (artifacts ? page.waitForTimeout(ms) : Promise.resolve());

test.use({ video: 'on' });

test('about wording and contact row (desktop)', async ({ page }) => {
  test.slow(!!artifacts);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(pageUrl);
  await pause(page);
  await expect(page.locator('#about')).toContainText('I am married with three amazing kids.');
  await expect(page.locator('#about')).not.toContainText('two amazing kids');
  await page.locator('#about').scrollIntoViewIfNeeded();
  await pause(page);
  await shot(page, '01-about.png');
  expect(await page.content()).not.toMatch(/instagram/i);
  await page.locator('#contact').scrollIntoViewIfNeeded();
  await pause(page);
  const li = page.locator('#contact a[href*="linkedin"]');
  const mail = page.locator('#contact a[href^="mailto"]');
  await expect(li).toBeVisible();
  await expect(mail).toBeVisible();
  const a = (await li.boundingBox())!;
  const b = (await mail.boundingBox())!;
  const centre = ((a.x + a.width / 2) + (b.x + b.width / 2)) / 2;
  expect(Math.abs(centre - 640)).toBeLessThan(15);
  await shot(page, '02-contact.png');
  await pause(page);
});

for (const width of [375, 320]) {
  test(`mobile ${width}px no horizontal scroll and navbar toggles`, async ({ page }) => {
    test.slow(!!artifacts);
    await page.setViewportSize({ width, height: 700 });
    await page.goto(pageUrl);
    await pause(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const h1s = page.locator('header.masthead h1');
    for (let i = 0; i < (await h1s.count()); i++) {
      const h1 = (await h1s.nth(i).boundingBox())!;
      expect(h1.x).toBeGreaterThanOrEqual(0);
      expect(h1.x + h1.width).toBeLessThanOrEqual(width);
    }
    await shot(page, `03-mobile-${width}.png`);
    await page.locator('.navbar-toggler').click();
    await expect(page.locator('#navbarResponsive')).toHaveClass(/\bshow\b/);
    await pause(page);
    await shot(page, `04-menu-open-${width}.png`);
    await page.locator('.navbar-toggler').click();
    await expect(page.locator('#navbarResponsive')).not.toHaveClass(/\b(show|collapsing)\b/);
    await expect(page.locator('#navbarResponsive')).toBeHidden();
    await pause(page);
    await page.locator('#contact').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await shot(page, `05-contact-${width}.png`);
  });
}

test('mobile menu closes when a nav link is clicked', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto(pageUrl);
  await page.locator('.navbar-toggler').click();
  await expect(page.locator('#navbarResponsive')).toHaveClass(/\bshow\b/);
  await page.locator('#navbarResponsive a.js-scroll-trigger[href="#contact"]').click();
  await expect(page.locator('#navbarResponsive')).toBeHidden();
});

test('local assets load without 404 and CV link resolves', async ({ page }) => {
  const failed: string[] = [];
  page.on('requestfailed', (r) => { if (r.url().startsWith('file://')) failed.push(r.url()); });
  await page.goto(pageUrl);
  await page.waitForLoadState('load');
  expect(failed).toEqual([]);
  const href = await page.locator('a[href$="cv.pdf"]').first().getAttribute('href');
  expect(fs.existsSync(path.resolve(__dirname, '..', href!))).toBe(true);
  const icon = await page.locator('link[rel*="icon"]').getAttribute('href');
  expect(fs.existsSync(path.resolve(__dirname, '..', icon!))).toBe(true);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('header.masthead')!).backgroundImage);
  expect(bg).toContain('bg-masthead.jpg');
  expect(fs.existsSync(path.resolve(__dirname, '..', 'img/bg-masthead.jpg'))).toBe(true);
});
