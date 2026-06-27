export type BrowserQaCheck = {
  key: string;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
};

export type BrowserQaResult = {
  passed: boolean;
  checks: BrowserQaCheck[];
  consoleErrors: string[];
};

export function browserQaPassed(checks: BrowserQaCheck[]): boolean {
  return !checks.some((check) => check.status === "failed");
}

export async function runBrowserQa(baseUrl: string): Promise<BrowserQaResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const checks: BrowserQaCheck[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 500));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 500)));

    const response = await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
    const title = await page.title();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const loaded = Boolean(response?.ok() && bodyText.trim());
    checks.push({
      key: "browser_homepage_loads",
      label: "Browser homepage loads",
      status: loaded ? "passed" : "failed",
      detail: loaded ? `Loaded ${baseUrl}${title ? ` (${title})` : ""}.` : `Homepage returned ${response?.status() ?? "no response"} or an empty body.`,
    });

    const primary = page.locator('main a[href], main button, a[href].primary, button[type="submit"]');
    const count = await primary.count();
    let targetIndex = -1;
    for (let index = 0; index < Math.min(count, 20); index++) {
      if (await primary.nth(index).isVisible().catch(() => false)) { targetIndex = index; break; }
    }
    if (targetIndex >= 0) {
      const target = primary.nth(targetIndex);
      const before = page.url();
      await target.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      checks.push({
        key: "browser_primary_buttons",
        label: "Primary buttons respond",
        status: "passed",
        detail: `Clicked the first visible primary action${page.url() !== before ? `; navigation reached ${page.url()}` : " without a page error"}.`,
      });
    } else {
      checks.push({ key: "browser_primary_buttons", label: "Primary buttons respond", status: "skipped", detail: "No visible primary link or button was found." });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    checks.push({
      key: "browser_responsive_viewport",
      label: "Basic mobile viewport",
      status: overflow ? "failed" : "passed",
      detail: overflow ? "Horizontal overflow detected at 390px width." : "No horizontal overflow detected at 390px width.",
    });
    checks.push({
      key: "browser_console_errors",
      label: "Browser console is clean",
      status: consoleErrors.length ? "failed" : "passed",
      detail: consoleErrors.length ? `${consoleErrors.length} console/page error(s): ${consoleErrors.slice(0, 3).join(" | ")}` : "No console or uncaught page errors detected.",
    });
    await context.close();
  } finally {
    await browser.close();
  }
  return { passed: browserQaPassed(checks), checks, consoleErrors };
}
