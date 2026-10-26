import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

interface UiEvent { preventDefault(): void; detail?: unknown }
type Listener = (event: UiEvent) => void | Promise<void>;

export function eventTarget() {
  const listeners = new Map<string, Listener[]>();
  return {
    addEventListener(name: string, listener: Listener) { listeners.set(name, [...listeners.get(name) ?? [], listener]); },
    emit(name: string, detail?: unknown) {
      for (const listener of listeners.get(name) ?? []) void listener({ preventDefault() {}, detail });
    },
    async emitAsync(name: string, detail?: unknown) {
      for (const listener of listeners.get(name) ?? []) await listener({ preventDefault() {}, detail });
    },
  };
}

export class UiElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  required = false;
  type = "";
  name = "";
  label = "";
  id = "";
  tagName = "";
  className = "";
  href = "";
  scrollTop = 0;
  scrollHeight = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: UiElement[] = [];
  readonly attributes = new Map<string, string>();
  private readonly events = eventTarget();
  // The library harness rejects every disabled interaction; debate harnesses
  // also exercise programmatic input/change events on disabled controls.
  constructor(private readonly disabledEvents: "all" | "click" = "click") {}
  append(...children: UiElement[]): void { this.children.push(...children); }
  replaceChildren(...children: UiElement[]): void { this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener = this.events.addEventListener;
  focus(): void {}
  pause(): void {}
  emit(name: string, detail?: unknown): void {
    if (this.disabledEvents === "all") assert.equal(this.disabled, false, `Cannot interact with disabled ${this.id}`);
    else if (this.disabled && name === "click") throw new Error(`Cannot click disabled ${this.id}`);
    this.events.emit(name, detail);
  }
}

export async function htmlElements(disabledEvents: "all" | "click" = "click") {
  const html = await readFile(resolve("web/index.html"), "utf8");
  const elements = new Map<string, UiElement>();
  for (const match of html.matchAll(/id="([^"]+)"/gu)) {
    const element = new UiElement(disabledEvents); element.id = match[1]!; elements.set(element.id, element);
  }
  return { html, element(id: string): UiElement {
    const found = elements.get(id);
    assert.ok(found, `The real HTML must provide #${id}`);
    return found;
  } };
}

export function memoryStorage(values = new Map<string, string>()) {
  return { getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value), removeItem: (name: string) => values.delete(name) };
}

export async function runUiScript(path: string, globals: Record<string, unknown>, transform = (source: string) => source): Promise<void> {
  const context = createContext(globals);
  runInContext(await readFile(resolve("web/ui.js"), "utf8"), context, { filename: "web/ui.js" });
  runInContext(transform(await readFile(resolve(path), "utf8")), context, { filename: path });
}

export async function flush(turns = 1): Promise<void> {
  for (let step = 0; step < turns; step++) await new Promise<void>(done => setImmediate(done));
}

export function textOf(element: UiElement): string { return [element.textContent, ...element.children.map(textOf)].join(" "); }
