import {
  App,
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
  agentsFile: string;
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

interface SourceState {
  mtime: number;
  size: number;
  syncedAt: string;
  writtenFiles: string[];
}

interface VaultButlerState {
  version: number;
  sources: Record<string, SourceState>;
}

interface RawSource {
  path: string;
  content: string;
  mtime: number;
  size: number;
}

const DEFAULT_SETTINGS: VaultButlerSettings = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  rawFolder: "raw",
  wikiFolder: "wiki",
  indexFile: "index.md",
  agentsFile: "AGENTS.md",
  maxRawFilesPerRun: 20,
};

const HIDDEN_FOLDER = ".vault-butler";
const LOG_FILE = `${HIDDEN_FOLDER}/log.md`;
const STATE_FILE = `${HIDDEN_FOLDER}/state.json`;

const AGENTS_TEMPLATE = `# Vault Butler Rules

You maintain this Obsidian vault as a Markdown wiki.

## Folders

- \`raw/\` contains immutable source notes. Never edit or rewrite raw files.
- \`wiki/\` contains synthesized wiki pages.
- \`index.md\` is the navigation map.
- \`.vault-butler/log.md\` is the hidden maintenance log.
- \`.vault-butler/state.json\` tracks incremental sync state.

## Writing Rules

- Write durable knowledge into focused wiki pages.
- Preserve source references with Obsidian links when useful.
- Prefer updating existing pages over creating duplicates.
- Keep claims grounded in the source material.
- Use concise Markdown with clear headings.
- Each generated page should include a source section with the raw note path and latest raw update time.

## Suggested Wiki Areas

- \`wiki/concepts/\`
- \`wiki/projects/\`
- \`wiki/workflows/\`
- \`wiki/sources/\`
- \`wiki/decisions/\`
`;

export default class VaultButlerPlugin extends Plugin {
  settings!: VaultButlerSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("refresh-cw", "Vault Butler: Update wiki", () => {
      void this.runSafely(() => this.updateWikiFromRawChanges());
    });

    this.addCommand({
      id: "update-wiki-from-raw-changes",
      name: "Update wiki from raw changes",
      callback: () => this.runSafely(() => this.updateWikiFromRawChanges()),
    });

    this.addCommand({
      id: "rebuild-wiki-index",
      name: "Rebuild wiki index locally",
      callback: () => this.runSafely(() => this.rebuildIndex()),
    });

    this.addCommand({
      id: "create-agents-template",
      name: "Create AGENTS.md template",
      callback: () => this.runSafely(() => this.createAgentsTemplate()),
    });

    this.addSettingTab(new VaultButlerSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.rawFolder = cleanPath(this.settings.rawFolder);
    this.settings.wikiFolder = cleanPath(this.settings.wikiFolder);
    this.settings.indexFile = cleanPath(this.settings.indexFile);
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
      new Notice(`Vault Butler error: ${errorMessage(error)}`, 12000);
      await this.appendLog(`Error: ${errorMessage(error)}`);
    }
  }

  async createAgentsTemplate() {
    const path = cleanPath(this.settings.agentsFile);
    if (!isRootMarkdownFile(path)) {
      new Notice("AGENTS file must be a root-level Markdown file.");
      return;
    }

    await this.upsertFile(path, AGENTS_TEMPLATE);
    new Notice(`Vault Butler wrote ${path}.`);
  }

  async updateWikiFromRawChanges() {
    if (!this.settings.apiKey.trim()) {
      new Notice("Set an API key in Vault Butler settings first.");
      return;
    }

    const changedSources = await this.collectChangedRawSources();
    if (changedSources.length === 0) {
      new Notice("Vault Butler: wiki is already up to date.");
      await this.appendLog("No raw changes detected.");
      return;
    }

    new Notice(`Vault Butler syncing ${changedSources.length} changed raw file(s)...`, 8000);
    const existingWiki = await this.readExistingWikiSummary();
    const agents = await this.readOptionalFile(this.settings.agentsFile);
    const response = await this.requestWikiPlan(changedSources, existingWiki, agents);

    if (!response.files || response.files.length === 0) {
      new Notice("The model did not return any wiki files.");
      await this.appendLog(`No wiki files returned for ${changedSources.length} changed raw file(s).`);
      return;
    }

    let writtenCount = 0;
    for (const file of response.files) {
      await this.safeWriteWikiFile(file.path, file.content);
      writtenCount += 1;
    }

    await this.recordSyncedSources(changedSources, response.files);
    await this.rebuildIndex(false);
    await this.appendLog(
      `Synced ${changedSources.length} raw file(s); wrote ${writtenCount} wiki file(s). Latest raw update: ${latestMtimeIso(changedSources)}. Sources: ${changedSources.map((source) => source.path).join(", ")}`,
    );
    new Notice(`Vault Butler synced ${changedSources.length} raw file(s), wrote ${writtenCount} wiki file(s).`);
  }

  async collectChangedRawSources(): Promise<RawSource[]> {
    const rawFolder = this.app.vault.getAbstractFileByPath(this.settings.rawFolder);
    if (!(rawFolder instanceof TFolder)) {
      throw new Error(`Raw folder not found: ${this.settings.rawFolder}`);
    }

    const state = await this.readState();
    const files = this.collectMarkdownFiles(rawFolder);
    const changed = files.filter((file) => {
      const previous = state.sources[file.path];
      return !previous || previous.mtime !== file.stat.mtime || previous.size !== file.stat.size;
    });

    const limited = changed.slice(0, this.settings.maxRawFilesPerRun);
    return Promise.all(
      limited.map(async (file) => ({
        path: file.path,
        content: await this.app.vault.read(file),
        mtime: file.stat.mtime,
        size: file.stat.size,
      })),
    );
  }

  async recordSyncedSources(sources: RawSource[], writtenFiles: WikiFile[]) {
    const state = await this.readState();
    const syncedAt = new Date().toISOString();
    const writtenPaths = writtenFiles.map((file) => cleanPath(file.path));

    for (const source of sources) {
      state.sources[source.path] = {
        mtime: source.mtime,
        size: source.size,
        syncedAt,
        writtenFiles: writtenPaths,
      };
    }

    await this.writeState(state);
  }

  async requestWikiPlan(sources: RawSource[], existingWiki: string, agents: string): Promise<LlmWikiResponse> {
    const url = `${this.settings.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
    const sourceText = sources
      .map(
        (source) =>
          `SOURCE: ${source.path}\nLATEST_RAW_UPDATE: ${new Date(source.mtime).toISOString()}\nSIZE_BYTES: ${source.size}\n\n${source.content}`,
      )
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
Incrementally update the Markdown wiki from the changed raw source notes.

Constraints:
- Return JSON shaped as {"summary":"...","files":[{"path":"wiki/...md","content":"..."}]}.
- Every file path must be inside ${this.settings.wikiFolder}/ and end in .md.
- Return the full desired content for each file. Existing files may be overwritten.
- Prefer updating existing related wiki pages over creating duplicates.
- Use Obsidian links where useful.
- Include source references and latest raw update time in each generated page.
- Do not write index.md, AGENTS.md, hidden files, raw files, or arbitrary paths.

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

    await this.safeWriteIndexFile(lines.join("\n").trimEnd() + "\n");
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
    const files = this.collectWikiMarkdownFiles().slice(0, 120);
    return files.map((file) => `- ${file.path}`).join("\n");
  }

  async readOptionalFile(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    return "";
  }

  async safeWriteWikiFile(path: string, content: string) {
    const clean = cleanPath(path);
    if (!this.isAllowedWikiPath(clean)) {
      throw new Error(`Refusing to write outside wiki folder: ${path}`);
    }
    await this.upsertFile(clean, content.trimEnd() + "\n");
  }

  async safeWriteIndexFile(content: string) {
    const clean = cleanPath(this.settings.indexFile);
    if (!isRootMarkdownFile(clean)) {
      throw new Error(`Index file must be a root-level Markdown file: ${clean}`);
    }
    await this.upsertFile(clean, content);
  }

  async appendLog(message: string) {
    const line = `- ${new Date().toISOString()} - ${message}\n`;
    const existing = await this.readOptionalFile(LOG_FILE);
    await this.upsertFile(LOG_FILE, existing ? existing.trimEnd() + "\n" + line : "# Vault Butler Log\n\n" + line);
  }

  async readState(): Promise<VaultButlerState> {
    const text = await this.readOptionalFile(STATE_FILE);
    if (!text.trim()) {
      return { version: 1, sources: {} };
    }

    try {
      const state = JSON.parse(text) as VaultButlerState;
      return {
        version: state.version || 1,
        sources: state.sources || {},
      };
    } catch {
      return { version: 1, sources: {} };
    }
  }

  async writeState(state: VaultButlerState) {
    await this.upsertFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
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
    const parts = cleanPath(path).split("/");
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

  isAllowedWikiPath(path: string): boolean {
    const clean = cleanPath(path);
    const wiki = `${this.settings.wikiFolder}/`;
    return clean.startsWith(wiki) && clean.endsWith(".md") && !clean.includes("../") && !clean.startsWith(`${wiki}drafts/`);
  }
}

type PathSettingKey = "rawFolder" | "wikiFolder" | "indexFile" | "agentsFile";

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
    this.addPathSetting("Wiki folder", "AI-synthesized pages are written here and may be overwritten.", "wikiFolder");
    this.addPathSetting("Index file", "Root-level Markdown navigation file.", "indexFile");
    this.addPathSetting("AGENTS file", "Root-level Markdown rules file.", "agentsFile");

    new Setting(containerEl)
      .setName("Max raw files per run")
      .setDesc("Caps the one-click update command to keep requests manageable.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxRawFilesPerRun)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.maxRawFilesPerRun = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Hidden log and state")
      .setDesc(`Vault Butler writes maintenance files to ${LOG_FILE} and ${STATE_FILE}.`);
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

function latestMtimeIso(sources: RawSource[]): string {
  return new Date(Math.max(...sources.map((source) => source.mtime))).toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
