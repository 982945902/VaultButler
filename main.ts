import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

interface VaultButlerSettings {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  rawFolder: string;
  wikiFolder: string;
  indexFile: string;
  logFile: string;
  agentsFile: string;
  previewMode: boolean;
  maxRawFilesPerRun: number;
}

interface WikiFile {
  path: string;
  content: string;
}

interface LlmWikiResponse {
  summary?: string;
  files?: WikiFile[];
}

const DEFAULT_SETTINGS: VaultButlerSettings = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  rawFolder: "raw",
  wikiFolder: "wiki",
  indexFile: "index.md",
  logFile: "log.md",
  agentsFile: "AGENTS.md",
  previewMode: true,
  maxRawFilesPerRun: 20,
};

const AGENTS_TEMPLATE = `# Vault Butler Rules

You maintain this Obsidian vault as a Markdown wiki.

## Folders

- \`raw/\` contains immutable source notes. Never edit or rewrite raw files.
- \`wiki/\` contains synthesized wiki pages.
- \`index.md\` is the navigation map.
- \`log.md\` is an append-only maintenance log.

## Writing Rules

- Write durable knowledge into focused wiki pages.
- Preserve source references with Obsidian links when useful.
- Prefer updating existing pages over creating duplicates.
- Keep claims grounded in the source material.
- Use concise Markdown with clear headings.

## Suggested Wiki Areas

- \`wiki/concepts/\`
- \`wiki/projects/\`
- \`wiki/workflows/\`
- \`wiki/sources/\`
- \`wiki/decisions/\`
- \`wiki/drafts/\`
`;

export default class VaultButlerPlugin extends Plugin {
  settings!: VaultButlerSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "create-agents-template",
      name: "Create AGENTS.md template",
      callback: () => this.runSafely(() => this.createAgentsTemplate()),
    });

    this.addCommand({
      id: "ingest-current-note",
      name: "Ingest current note into wiki",
      callback: () => this.runSafely(() => this.ingestCurrentNote()),
    });

    this.addCommand({
      id: "organize-raw-folder",
      name: "Organize raw folder into wiki",
      callback: () => this.runSafely(() => this.organizeRawFolder()),
    });

    this.addCommand({
      id: "rebuild-wiki-index",
      name: "Rebuild wiki index locally",
      callback: () => this.runSafely(() => this.rebuildIndex()),
    });

    this.addCommand({
      id: "apply-current-preview",
      name: "Apply current preview to wiki",
      callback: () => this.runSafely(() => this.applyCurrentPreview()),
    });

    this.addCommand({
      id: "toggle-preview-mode",
      name: "Toggle preview mode",
      callback: () => this.runSafely(async () => {
        this.settings.previewMode = !this.settings.previewMode;
        await this.saveSettings();
        new Notice(`Vault Butler preview mode ${this.settings.previewMode ? "enabled" : "disabled"}.`);
      }),
    });

    this.addSettingTab(new VaultButlerSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.rawFolder = cleanPath(this.settings.rawFolder);
    this.settings.wikiFolder = cleanPath(this.settings.wikiFolder);
    this.settings.indexFile = cleanPath(this.settings.indexFile);
    this.settings.logFile = cleanPath(this.settings.logFile);
    this.settings.agentsFile = cleanPath(this.settings.agentsFile);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async runSafely(work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      console.error("Vault Butler error", error);
      new Notice(`Vault Butler error: ${errorMessage(error)}`);
    }
  }

  async createAgentsTemplate() {
    const path = cleanPath(this.settings.agentsFile);
    if (!isRootMarkdownFile(path)) {
      new Notice("AGENTS file must be a root-level Markdown file.");
      return;
    }

    await this.ensureParentFolder(path);
    await this.upsertFile(path, AGENTS_TEMPLATE);
    new Notice(`Vault Butler wrote ${path}.`);
  }

  async applyCurrentPreview() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = active?.file;
    if (!file) {
      new Notice("Open a Vault Butler preview file first.");
      return;
    }

    const draftsPrefix = `${this.settings.wikiFolder}/drafts/`;
    if (!cleanPath(file.path).startsWith(draftsPrefix)) {
      new Notice(`Open a preview file under ${draftsPrefix} first.`);
      return;
    }

    const content = await this.app.vault.read(file);
    const proposedFiles = parsePreviewFiles(content);
    if (proposedFiles.length === 0) {
      new Notice("No proposed wiki files found in this preview.");
      return;
    }

    let count = 0;
    for (const proposed of proposedFiles) {
      await this.safeWriteWikiFile(proposed.path, proposed.content);
      count += 1;
    }

    await this.rebuildIndex(false);
    await this.appendLog(`Applied preview [[${file.path}]]; wrote ${count} wiki file(s).`);
    new Notice(`Applied ${count} wiki file(s) from preview.`);
  }

  async ingestCurrentNote() {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = active?.file;
    if (!file) {
      new Notice("Open a Markdown note before ingesting.");
      return;
    }

    if (!this.isInRawFolder(file.path)) {
      new Notice(`Vault Butler only ingests files from ${this.settings.rawFolder}/.`);
      return;
    }

    const content = await this.app.vault.read(file);
    new Notice(`Vault Butler ingesting ${file.path}...`, 6000);
    await this.ingestSources([{ path: file.path, content }], "current note");
  }

  async organizeRawFolder() {
    const rawFolder = this.app.vault.getAbstractFileByPath(this.settings.rawFolder);
    if (!(rawFolder instanceof TFolder)) {
      new Notice(`Raw folder not found: ${this.settings.rawFolder}`);
      return;
    }

    const files = this.collectMarkdownFiles(rawFolder).slice(0, this.settings.maxRawFilesPerRun);
    if (files.length === 0) {
      new Notice(`No Markdown files found under ${this.settings.rawFolder}/.`);
      return;
    }

    const sources = await Promise.all(
      files.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.read(file),
      })),
    );

    await this.ingestSources(sources, `${files.length} raw files`);
  }

  async ingestSources(sources: Array<{ path: string; content: string }>, label: string) {
    if (!this.settings.apiKey.trim()) {
      new Notice("Set an API key in Vault Butler settings first.");
      return;
    }

    new Notice(`Vault Butler is organizing ${label}...`);
    const existingWiki = await this.readExistingWikiSummary();
    const agents = await this.readOptionalFile(this.settings.agentsFile);
    const response = await this.requestWikiPlan(sources, existingWiki, agents);

    if (!response.files || response.files.length === 0) {
      new Notice("The model did not return any wiki files.");
      await this.appendLog(`No wiki files returned for ${label}.`);
      return;
    }

    if (this.settings.previewMode) {
      const previewPath = this.makePreviewPath();
      const previewBody = this.renderPreview(response, sources);
      await this.safeWriteWikiFile(previewPath, previewBody);
      await this.appendLog(`Preview created for ${label}: [[${previewPath}]]`);
      new Notice(`Preview written to ${previewPath}.`);
      return;
    }

    let count = 0;
    for (const file of response.files) {
      await this.safeWriteWikiFile(file.path, file.content);
      count += 1;
    }

    await this.rebuildIndex(false);
    await this.appendLog(`Ingested ${label}; wrote ${count} wiki file(s).`);
    new Notice(`Vault Butler wrote ${count} wiki file(s).`);
  }

  async requestWikiPlan(
    sources: Array<{ path: string; content: string }>,
    existingWiki: string,
    agents: string,
  ): Promise<LlmWikiResponse> {
    const url = `${this.settings.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const sourceText = sources
      .map((source) => `SOURCE: ${source.path}\n\n${source.content}`)
      .join("\n\n---\n\n");

    const messages = [
      {
        role: "system",
        content:
          "You are Vault Butler, an Obsidian Markdown wiki maintainer. Return only valid JSON. Do not include markdown fences.",
      },
      {
        role: "user",
        content: `Rules from AGENTS.md:
${agents || "(none)"}

Existing wiki inventory:
${existingWiki || "(none)"}

Task:
Convert the source notes into durable wiki pages.

Constraints:
- Return JSON shaped as {"summary":"...","files":[{"path":"wiki/...md","content":"..."}]}.
- Every file path must be inside ${this.settings.wikiFolder}/ and end in .md.
- Use Obsidian links where useful.
- Include source references in the content.
- Do not write index.md, log.md, AGENTS.md, raw files, or arbitrary paths.

${sourceText}`,
      },
    ];

    const result = await requestUrl({
      url,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      throw: false,
    });

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`LLM request failed with ${result.status}: ${result.text}`);
    }

    const payload = result.json as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("LLM response was empty.");
    }

    try {
      return JSON.parse(text) as LlmWikiResponse;
    } catch (error) {
      throw new Error(`Could not parse LLM JSON response: ${String(error)}`);
    }
  }

  async rebuildIndex(showNotice = true) {
    const files = this.collectWikiMarkdownFiles();
    const groups = new Map<string, TFile[]>();

    for (const file of files) {
      const relative = file.path.slice(this.settings.wikiFolder.length + 1);
      const group = relative.includes("/") ? relative.split("/")[0] : "pages";
      const existing = groups.get(group) ?? [];
      existing.push(file);
      groups.set(group, existing);
    }

    const lines = ["# Wiki Index", "", `Updated: ${new Date().toISOString()}`, ""];
    if (files.length === 0) {
      lines.push(`No wiki pages found under \`${this.settings.wikiFolder}/\`.`);
    } else {
      for (const [group, groupFiles] of [...groups.entries()].sort()) {
        lines.push(`## ${titleCase(group)}`, "");
        for (const file of groupFiles.sort((a, b) => a.path.localeCompare(b.path))) {
          lines.push(`- [[${file.path.replace(/\.md$/, "")}|${file.basename}]]`);
        }
        lines.push("");
      }
    }

    await this.safeWriteSpecialFile(this.settings.indexFile, lines.join("\n").trimEnd() + "\n");
    await this.appendLog(`Rebuilt ${this.settings.indexFile} with ${files.length} wiki page(s).`);
    if (showNotice) {
      new Notice(`Vault Butler rebuilt ${this.settings.indexFile}.`);
    }
  }

  collectMarkdownFiles(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") {
        out.push(child);
      } else if (child instanceof TFolder) {
        out.push(...this.collectMarkdownFiles(child));
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  collectWikiMarkdownFiles(): TFile[] {
    const wikiFolder = this.app.vault.getAbstractFileByPath(this.settings.wikiFolder);
    if (!(wikiFolder instanceof TFolder)) {
      return [];
    }
    return this.collectMarkdownFiles(wikiFolder);
  }

  async readExistingWikiSummary(): Promise<string> {
    const files = this.collectWikiMarkdownFiles().slice(0, 80);
    return files.map((file) => `- ${file.path}`).join("\n");
  }

  async readOptionalFile(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    return "";
  }

  renderPreview(response: LlmWikiResponse, sources: Array<{ path: string }>): string {
    const lines = [
      "# Vault Butler Preview",
      "",
      `Created: ${new Date().toISOString()}`,
      "",
      "## Sources",
      "",
      ...sources.map((source) => `- [[${source.path.replace(/\.md$/, "")}|${source.path}]]`),
      "",
      "## Summary",
      "",
      response.summary || "(No summary returned.)",
      "",
      "## Proposed Files",
      "",
    ];

    for (const file of response.files ?? []) {
      lines.push(`### ${file.path}`, "", "```markdown", file.content.trimEnd(), "```", "");
    }

    return lines.join("\n");
  }

  makePreviewPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return normalizePath(`${this.settings.wikiFolder}/drafts/vault-butler-preview-${stamp}.md`);
  }

  async safeWriteWikiFile(path: string, content: string) {
    const clean = cleanPath(path);
    if (!this.isAllowedWikiPath(clean)) {
      throw new Error(`Refusing to write outside wiki folder: ${path}`);
    }
    await this.upsertFile(clean, content.trimEnd() + "\n");
  }

  async safeWriteSpecialFile(path: string, content: string) {
    const clean = cleanPath(path);
    const allowed = [this.settings.indexFile, this.settings.logFile].map(cleanPath);
    if (!allowed.includes(clean) || !isRootMarkdownFile(clean)) {
      throw new Error(`Refusing to write special file: ${path}`);
    }
    await this.upsertFile(clean, content);
  }

  async appendLog(message: string) {
    const path = cleanPath(this.settings.logFile);
    if (!isRootMarkdownFile(path)) {
      throw new Error("Log file must be a root-level Markdown file.");
    }

    const line = `- ${new Date().toISOString()} - ${message}\n`;
    const existing = await this.readOptionalFile(path);
    await this.safeWriteSpecialFile(path, existing ? existing.trimEnd() + "\n" + line : "# Vault Butler Log\n\n" + line);
  }

  async upsertFile(path: string, content: string) {
    await this.ensureParentFolder(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return;
    }
    if (existing) {
      throw new Error(`Path exists and is not a file: ${path}`);
    }
    await this.app.vault.create(path, content);
  }

  async ensureParentFolder(path: string) {
    const parts = path.split("/");
    parts.pop();
    if (parts.length === 0) {
      return;
    }

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Cannot create folder because a file exists at ${current}`);
      }
    }
  }

  isInRawFolder(path: string): boolean {
    const raw = `${this.settings.rawFolder}/`;
    return cleanPath(path).startsWith(raw);
  }

  isAllowedWikiPath(path: string): boolean {
    const clean = cleanPath(path);
    const wiki = `${this.settings.wikiFolder}/`;
    return clean.startsWith(wiki) && clean.endsWith(".md") && !clean.includes("../");
  }
}

type PathSettingKey = "rawFolder" | "wikiFolder" | "indexFile" | "logFile" | "agentsFile";

class VaultButlerSettingTab extends PluginSettingTab {
  plugin: VaultButlerPlugin;

  constructor(app: App, plugin: VaultButlerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("vault-butler-settings");

    containerEl.createEl("h2", { text: "Vault Butler" });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("OpenAI-compatible API base URL.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim() || DEFAULT_SETTINGS.apiBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Stored in Obsidian plugin data on this device.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (value) => {
            this.plugin.settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .addText((text) =>
        text.setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.saveSettings();
        }),
      );

    this.addPathSetting("Raw folder", "Source notes. Vault Butler never writes here.", "rawFolder");
    this.addPathSetting("Wiki folder", "AI-synthesized pages are written here.", "wikiFolder");
    this.addPathSetting("Index file", "Root-level Markdown navigation file.", "indexFile");
    this.addPathSetting("Log file", "Root-level append-only maintenance log.", "logFile");
    this.addPathSetting("AGENTS file", "Root-level Markdown rules file.", "agentsFile");

    new Setting(containerEl)
      .setName("Preview mode")
      .setDesc("When enabled, LLM output is written to wiki/drafts as a preview instead of real wiki pages.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.previewMode).onChange(async (value) => {
          this.plugin.settings.previewMode = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max raw files per run")
      .setDesc("Caps the Organize raw folder command to keep requests manageable.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxRawFilesPerRun)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxRawFilesPerRun = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
          await this.plugin.saveSettings();
        }),
      );
  }

  addPathSetting(name: string, desc: string, key: PathSettingKey) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(String(this.plugin.settings[key])).onChange(async (value) => {
          this.plugin.settings[key] = cleanPath(value || DEFAULT_SETTINGS[key]);
          await this.plugin.saveSettings();
        }),
      );
  }
}

function cleanPath(path: string): string {
  return normalizePath(path.trim()).replace(/^\/+/, "").replace(/\/+$/, "");
}

function isRootMarkdownFile(path: string): boolean {
  return path.endsWith(".md") && !path.includes("/");
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsePreviewFiles(content: string): WikiFile[] {
  const files: WikiFile[] = [];
  const pattern = /^### (.+\.md)\n+```markdown\n([\s\S]*?)\n```/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    files.push({
      path: cleanPath(match[1]),
      content: match[2].trimEnd() + "\n",
    });
  }

  return files;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
