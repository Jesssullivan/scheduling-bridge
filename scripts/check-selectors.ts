/**
 * Check which CSS selectors exist in the rendered Acuity React SPA.
 * Run: npx tsx scripts/check-selectors.ts
 */
import { chromium } from 'playwright-core';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  console.log('Loading https://MassageIthaca.as.me/ ...');
  await page.goto('https://MassageIthaca.as.me/', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('Page loaded. Checking selectors...\n');

  const checks = [
    '.select-item',
    '.select-item-box',
    '.appointment-type-name',
    '.type-name',
    'button.btn',
    '.monthly-calendar-v2',
    '.react-calendar',
    '.react-calendar__tile',
    '.scheduleday',
    '.time-selection',
    '#secondo-container',
    '.select-label',
    '.duration-container',
    '.category-group',
  ];

  for (const sel of checks) {
    const count = await page.locator(sel).count();
    console.log(`  ${sel}: ${count} elements`);
  }

  console.log('\n--- Service names found ---');
  const nameEl = await page.locator('.appointment-type-name').allTextContents();
  if (nameEl.length > 0) {
    for (const n of nameEl) console.log(`  ${JSON.stringify(n.trim())}`);
  } else {
    console.log('  (none via .appointment-type-name)');
    // Try alternative
    const alt = await page.locator('.type-name, h3').allTextContents();
    for (const n of alt.slice(0, 10)) console.log(`  alt: ${JSON.stringify(n.trim())}`);
  }

  // Click the "Select" button on first category (Urgent Care)
  console.log('\n--- Clicking category Select button ---');
  await page.locator('.select-item button.btn').first().click();
  await page.waitForTimeout(3000);
  console.log('URL after click:', page.url());

  // Check what the page shows now
  const afterClick = await page.locator('.select-item').count();
  console.log('.select-item after category click:', afterClick);

  const names2 = await page.locator('.appointment-type-name').allTextContents();
  console.log('Names after click:', JSON.stringify(names2.map(n => n.trim())));

  const btns2 = await page.locator('button.btn').allTextContents();
  console.log('Buttons:', JSON.stringify(btns2.map(b => b.trim())));

  // Check for calendar
  const cal = await page.locator('.monthly-calendar-v2, .react-calendar').count();
  console.log('Calendar elements:', cal);

  // Dump some HTML
  console.log('\n--- Page content snippet ---');
  const content = await page.locator('#secondo-container').innerHTML();
  // Find the first .select-item content
  const match = content.match(/<div[^>]*class="[^"]*select-item[^"]*"[^>]*>[\s\S]{0,500}/);
  console.log(match?.[0]?.slice(0, 500) ?? '(no .select-item found in innerHTML)');

  await browser.close();
}

main().catch(console.error);
