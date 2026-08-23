import type { Locator, Page } from "playwright";
import { sanitizeBrowserValue, type RecordedBrowserEvent, type SemanticTarget } from "@/lib/teach-hermes-recording";

export type RecordedEventTransport = (sequence: number, event: RecordedBrowserEvent) => Promise<unknown>;

async function identify(locator: Locator): Promise<SemanticTarget> {
  return locator.evaluate((element) => {
    const node = element as HTMLElement;
    const input = element as HTMLInputElement;
    const text = (value: unknown, max = 160) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || undefined;
    const labels = "labels" in input && input.labels ? Array.from(input.labels).map((label) => label.textContent).join(" ") : "";
    const tag = node.tagName.toLowerCase();
    const explicitRole = node.getAttribute("role");
    const role = explicitRole || (tag === "button" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "input" || tag === "textarea" ? "textbox" : undefined);
    const label = text(node.getAttribute("aria-label") || labels);
    const name = text(node.getAttribute("aria-label") || labels || (role === "button" || role === "link" ? node.textContent : input.name));
    const stableId = text(node.id || node.getAttribute("data-testid") || node.getAttribute("data-cy"), 120);
    const selectorHint = node.id ? `#${CSS.escape(node.id)}` : node.getAttribute("data-testid") ? `[data-testid="${CSS.escape(node.getAttribute("data-testid")!)}"]` : undefined;
    return { role: text(role, 80), name, label, stableId, selectorHint: text(selectorHint, 200), tag, inputType: text(input.type, 40), autocomplete: text(input.autocomplete, 80) };
  });
}

export class TeachHermesPlaywrightRecorder {
  private sequence = 0;
  constructor(private readonly page: Page, private readonly origin: string, private readonly transport: RecordedEventTransport) {}

  private async send(event: Omit<RecordedBrowserEvent, "pageUrl">) {
    const pageUrl = this.page.url();
    if (new URL(pageUrl).origin !== this.origin) throw new Error("Browser left the approved Builder preview origin.");
    this.sequence += 1;
    return this.transport(this.sequence, { ...event, pageUrl });
  }

  async navigate(pathOrUrl: string) {
    const destination = new URL(pathOrUrl, this.origin);
    if (destination.origin !== this.origin) throw new Error("Navigation is outside the approved Builder preview origin.");
    await this.page.goto(destination.href, { waitUntil: "domcontentloaded" });
    return this.send({ kind: "navigate", url: `${destination.pathname}${destination.search}` });
  }

  async click(locator: Locator) { const target = await identify(locator); await locator.click(); return this.send({ kind: "click", target }); }
  async fill(locator: Locator, value: string) { const target = await identify(locator); const safeValue = sanitizeBrowserValue(value, target); await locator.fill(value); return this.send({ kind: "fill", target, value: safeValue }); }
  async select(locator: Locator, value: string) { const target = await identify(locator); await locator.selectOption(value); return this.send({ kind: "select", target, value: sanitizeBrowserValue(value, target) }); }
  async submit(form: Locator) { const target = await identify(form); await form.evaluate((element) => (element as HTMLFormElement).requestSubmit()); return this.send({ kind: "submit", target }); }
  async checkpoint(text: string) { return this.send({ kind: "checkpoint", text }); }
  async observe() {
    const observation = await this.page.evaluate(() => ({
      title: document.title.slice(0, 160),
      pathname: location.pathname,
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).filter((node) => (node as HTMLElement).offsetParent !== null).slice(0, 10).map((node) => (node.textContent ?? "").trim().slice(0, 160)),
      actions: Array.from(document.querySelectorAll("button,a[href]")).filter((node) => (node as HTMLElement).offsetParent !== null).slice(0, 20).map((node) => (node.textContent ?? "").trim().slice(0, 160)),
      formLabels: Array.from(document.querySelectorAll("label")).filter((node) => (node as HTMLElement).offsetParent !== null).slice(0, 20).map((node) => (node.textContent ?? "").trim().slice(0, 160)),
    }));
    await this.send({ kind: "observe", text: JSON.stringify(observation) });
    return observation;
  }
}
