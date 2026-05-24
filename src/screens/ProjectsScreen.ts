import * as blessed from "blessed";
import { fetchProjects } from "../lib/api.js";
import type { AdoProject } from "../lib/types.js";
import type { AppContext } from "./context.js";

export class ProjectsScreen {
  readonly widget: blessed.Widgets.ListElement;
  private org = "";
  private projects: AdoProject[] = [];

  get footerText(): string {
    return " {cyan-fg}↑↓{/} Navigate  {cyan-fg}Enter{/} Select project  {cyan-fg}Esc{/} Back  {cyan-fg}r{/} Refresh  {cyan-fg}q{/} Quit";
  }

  constructor(
    private screen: blessed.Widgets.Screen,
    private ctx: AppContext,
  ) {
    this.widget = blessed.list({
      parent: screen, top: 1, left: 0, width: "100%", height: "100%-3",
      border: { type: "line" }, label: " Projects ",
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

  show(org: string): void {
    if (org !== this.org) {
      this.org = org;
      this.projects = [];
    }
    (this.widget as any).setLabel(` Projects — ${org} `);
    this.widget.show();
    this.widget.focus();
    if (this.projects.length === 0) this.load();
    else this.render();
  }

  hide(): void { this.widget.hide(); }

  private async load(): Promise<void> {
    this.ctx.setStatus(`Loading projects for ${this.org}…`, 0);
    try {
      const token = await this.ctx.getToken();
      this.projects = await fetchProjects(this.org, token);
      this.ctx.setStatus("", 0);
      this.render();
    } catch (e) {
      this.ctx.setStatus(`Error: ${(e as Error).message.slice(0, 80)}`, 10_000);
    }
  }

  private render(): void {
    (this.widget as any).setItems(this.projects.map(p => p.name));
    this.screen.render();
  }

  private registerKeys(): void {
    this.widget.key("enter", () => {
      const idx = (this.widget as any).selected as number ?? 0;
      const project = this.projects[idx];
      if (!project) return;
      this.ctx.setOrgProject(this.org, project.name);
      this.ctx.navigate({ view: "pipelines" });
    });
    this.widget.key(["escape", "backspace"], () => {
      this.ctx.navigate({ view: "orgs" });
    });
    this.widget.key("r", () => {
      this.projects = [];
      this.load();
    });
  }
}
