// pwScraper.js
const { chromium } = require('playwright');
const { performance } = require('perf_hooks');

/**
 * Shared browser + Canvas course scraper
 *
 * - Scrapes the course code from each row of https://utdallas.instructure.com/courses
 *   e.g. "CS-3162.052-SE-3162.052 - PROF RESPONSIBILITY IN CS  SE - F26"
 *   Only the first (prefix, number, section) is used: { prefix: "CS", number: "3162", section: "052" }
 *
 * - Loads from ACM API storage bucket (COURSEBOOK_URL), indexed by
 *     `${course_prefix}${course_number}.${section}` -> { activityType, firstInstructor }
 *
 * Filtering rules:
 * - If the course's code isn't in the JSON index -> remove
 * - If matched JSON activity_type is listed in EXCLUDED_ACTIVITY_TYPES -> remove
 *
 * Output:
 *   [{ course_id: "DEPT-NUM-LastName" }, ...]
 */

const EXCLUDED_ACTIVITY_TYPES = new Set([
  'Laboratory',
  'Laboratory - No Lab Fee',
  'Common Exam',
  'Dissertation',
  'Independent Study',
  'Internship',
  "Master's Thesis",
  'Practicum',
  'Research',
]);

const CANVAS_BASE_URL = 'https://utdallas.instructure.com';

let _browser = null;

async function getSharedBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
        '--single-process',
        '--no-zygote',
      ],
    });
  }
  return _browser;
}

function ms(n) {
  return `${Math.round(n)}ms`;
}

// Matches the first "PREFIX-NUM.SEC" or "PREFIX NUM.SEC" token in a course code string.
// e.g. "CS-3162.052-SE-3162.052" -> { prefix: "CS", number: "3162", section: "052" }
const COURSE_CODE_RE = /([A-Z]{2,4})[\s-](\d{3,4})\.([0-9A-Za-z]{1,3})/;

function parseCourseCode(codePart) {
  const m = codePart.match(COURSE_CODE_RE);
  if (!m) return null;
  return { prefix: m[1], number: m[2], section: m[3] };
}

class CanvasScraper {
  constructor(netid, password) {
    this.netid = netid;
    this.password = password;
    this.page = null;
  }

  async setupPageOptimizations(page) {
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(20000);

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
  }

  async buildClassesIndexByCode() {
    const coursebookUrl = process.env.COURSEBOOK_URL;
    const res = await fetch(coursebookUrl);
    const rows = await res.json();

    const idx = new Map();
    for (const row of rows) {
      const prefix = row.course_prefix.trim().toLowerCase();
      const number = row.course_number.trim();
      const section = row.section.trim().toLowerCase();
      const key = `${prefix}${number}.${section}`;

      const firstInstructor = (row.instructors || '').split(',')[0].trim();

      if (!idx.has(key)) {
        idx.set(key, { activityType: (row.activity_type || '').trim(), firstInstructor });
      }
    }

    console.log(`buildClassesIndexByCode: indexed ${idx.size} class codes from remote`);
    return idx;
  }

  // Auth (Canvas redirects straight to SSO from /courses)
  async login() {
    const t0 = performance.now();
    console.log('Logging in');

    await this.page.goto(`${CANVAS_BASE_URL}/courses`, { waitUntil: 'domcontentloaded' });

    await this.page.waitForSelector('#netid', { timeout: 10000 });
    await this.page.locator('#netid').fill(this.netid);
    await this.page.locator('#password').fill(this.password);
    await this.page.locator('#submit').click();

    const success = this.page.locator('tbody tr.course-list-table-row').first().waitFor({ timeout: 15000 });
    const invalidCreds = this.page
      .locator('//*[contains(@class,"error") and contains(., "Invalid")]')
      .waitFor({ timeout: 15000 });

    const result = await Promise.race([success.then(() => 'success'), invalidCreds.then(() => 'invalid')]);
    if (result === 'invalid') throw new Error('Login failed: Invalid username or password');

    console.log(`[perf] login total: ${ms(performance.now() - t0)}`);
  }

  // scrape function
  async scrapeCourses() {
    const t0 = performance.now();
    console.log('Scraping courses');

    const classesIndex = await this.buildClassesIndexByCode();

    const extracted = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('tbody tr.course-list-table-row'))
        .map((row) => row.querySelector('.course-list-favoritable')?.getAttribute('data-course-name'))
        .filter(Boolean)
        .map((name) => name.replace(/\s+/g, ' ').trim());
    });

    const out = [];
    for (const courseName of extracted) {
      const codePart = courseName.split(' - ')[0].trim();
      const code = parseCourseCode(codePart);
      if (!code) {
        console.log(`[DROP] ${courseName} -> could not parse course code`);
        continue;
      }

      const key = `${code.prefix.toLowerCase()}${code.number}.${code.section.toLowerCase()}`;
      const meta = classesIndex.get(key);
      if (!meta) {
        console.log(`[DROP] ${courseName} -> "${key}" not found in JSON`);
        continue;
      }

      if (EXCLUDED_ACTIVITY_TYPES.has(meta.activityType)) {
        console.log(`[DROP] ${courseName} -> activity_type excluded (${meta.activityType})`);
        continue;
      }

      const last = meta.firstInstructor.split(/\s+/).pop();
      const courseId = `${code.prefix}-${code.number}-${last}`;

      console.log(`[KEEP] ${courseName} -> ${courseId}`);
      out.push({ course_id: courseId });
    }

    console.log(`[perf] scrapeCourses total: ${ms(performance.now() - t0)}`);
    return out;
  }

  async scrapeCanvas() {
    const t0 = performance.now();

    const browser = await getSharedBrowser();
    const context = await browser.newContext();
    this.page = await context.newPage();

    try {
      await this.setupPageOptimizations(this.page);
      await this.login();
      const courses = await this.scrapeCourses();

      console.log(`[perf] scrapeCanvas total: ${ms(performance.now() - t0)}`);
      return courses;
    } finally {
      await context.close();
    }
  }
}

module.exports = { CanvasScraper };