# Vault Butler

An MVP Obsidian plugin that digests temporary notes into an **LLM-maintained Markdown wiki**.

It is designed for this workflow:

```text
temporary notes anywhere outside wiki/ = input material
wiki/                                  = AI-synthesized knowledge base
index.md                               = navigation map
AGENTS.md                              = rules for the AI organizer
.vault-butler/
  log.md                               = hidden maintenance log
  state.json                           = hidden plugin run state
```

## What it does

Commands:

- **Vault Butler: Digest source notes into wiki**
- **Vault Butler: Force update all source notes**
- **Vault Butler: Rebuild wiki index locally**
- **Vault Butler: Create AGENTS.md template**

The left ribbon button runs **Digest source notes into wiki**.

The plugin scans Markdown notes outside:

- `wiki/`
- `.vault-butler/`
- `.obsidian/`
- `index.md`
- `AGENTS.md`

It sends those notes to the LLM, writes the returned pages to `wiki/`, rebuilds `index.md`, and deletes the source notes after a successful run.

## Usage

Write temporary notes anywhere outside `wiki/`, `.vault-butler/`, and `.obsidian/`.

Then run:

```text
Vault Butler: Digest source notes into wiki
```

or click the Vault Butler ribbon button.

The command is intentionally destructive: once the LLM successfully returns wiki files and those files are written, the source notes used in that run are deleted.

To keep a note permanently, move it under `wiki/` or make it part of `AGENTS.md` / `index.md`.

## Install for development

```bash
bun install
bun run build
```

Then copy these files into your vault:

```text
YOUR_VAULT/.obsidian/plugins/vault-butler/
  manifest.json
  main.js
  styles.css
```

Restart Obsidian and enable **Vault Butler** in Community Plugins.

## Settings

Open:

```text
Settings -> Community plugins -> Vault Butler
```

Configure:

- API base URL: `https://api.openai.com/v1`
- API key: your OpenAI-compatible key
- Model: e.g. `gpt-4.1-mini`, `gpt-4o-mini`, or your OpenAI-compatible model
- Wiki folder: `wiki`
- Index file: `index.md`
- AGENTS file: `AGENTS.md`
- Max source files per run: `20`

The plugin uses the OpenAI-compatible `/chat/completions` API.

## Recommended Vault Layout

```text
vault/
  AGENTS.md
  index.md

  inbox.md
  scratch/
    temporary-note.md

  wiki/
    concepts/
    projects/
    workflows/
    examples/
    sources/
    decisions/

  .vault-butler/
    log.md
    state.json
```

## Destructive Behavior

Vault Butler treats source notes as disposable input.

Files that can be deleted after a successful digest:

- Markdown files outside `wiki/`
- Markdown files outside `.vault-butler/`
- Markdown files outside `.obsidian/`
- Markdown files other than `AGENTS.md`
- Markdown files other than `index.md`

After a successful digest:

- generated wiki pages are written or overwritten under `wiki/`
- `index.md` is rebuilt
- `.vault-butler/log.md` is appended
- source notes used for that run are deleted

If the LLM returns no files or the request fails, source notes are kept.
