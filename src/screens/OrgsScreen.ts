import * as blessed from "blessed";
import { fetchOrgs } from "../lib/api.js";
import type { AdoOrg } from "../lib/types.js";
import type { AppContext } from "./context.js";

export class OrgsScreen {
  readonly widget: blessed.Widgets.ListElement;
  private orgs: AdoOrg[] = [];

  get footerText(): string {
    return " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Select org  {cyan-fg}r{/} Refresh  {cyan-fg}q{/} Quit";
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.widget = blessed.list({
      parent: screen, top: 1, left: 0, width: "100%", height: "100%-3",
      border: { type: "line" }, label: " Azure DevOps Organizations ",
      tags: true, keys: true, vi: true, scrollable: true,
      scrollbar: { ch: "│", style: { fg: "blue" } },
      style: {
        border: { fg: "cyan" }, selected: { bg: "blue", fg: "white" },
        focus: { border: { fg: "white" } },
      },
      items: [], hidden: true,
    });
    this.registerKeys();
  }

  show(): void {
    this.widget.show();
    this.widget.focus();
    if (this.orgs.length === 0) this.load();
    else this.render();
  }

  hide(): void { this.widget.hide(); }

  private async load(): Promise<void> {
    this.ctx.setStatus("Loading organizations…", 0);
    try {
      const token = await this.ctx.getToken();
      this.orgs = await fetchOrgs(token);
      this.ctx.setStatus("", 0);
      this.render();
    } catch (e) {
      this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  private render(): void {
    (this.widget as any).setItems(this.orgs.map(o => o.accountName));
    this.screen.render();
  }

  private registerKeys(): void {
    this.widget.key("enter", () => {
      const idx = (this.widget as any).selected as number ?? 0;
      const org = this.orgs[idx];
      if (!org) return;
      this.ctx.navigate({ view: "projects", org: org.accountName });
    });
    this.widget.key("r", () => {
      this.orgs = [];
      this.load();
    });
  }
}
