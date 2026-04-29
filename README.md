# Vault Butler

An MVP Obsidian plugin that turns your vault into an **LLM-maintained Markdown wiki**.

It is designed for this workflow:

```text
raw/       = immutable source notes
wiki/      = AI-synthesized knowledge base
index.md   = navigation map
AGENTS.md  = rules for the AI organizer
.vault-butler/
  log.md     = hidden append-only maintenance log
  state.json = hidden incremental sync state
```

## What it does

Commands:

- **Vault Butler: Create AGENTS.md template**
- **Vault Butler: Update wiki from raw changes**
- **Vault Butler: Rebuild wiki index locally**

The left ribbon button runs **Update wiki from raw changes**.

The AI writes only to:

- your configured `wiki/` folder
- your configured `index.md`
- the hidden `.vault-butler/` maintenance folder

It refuses to write to `raw/` or arbitrary paths.

## Install for development

```bash
cd obsidian-vault-butler
npm install
npm run build
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
Settings → Community plugins → Vault Butler
```

Configure:

- API base URL: `https://api.openai.com/v1`
- API key: your OpenAI-compatible key
- Model: e.g. `gpt-4.1-mini`, `gpt-4o-mini`, or your OpenAI-compatible model
- Raw folder: `raw`
- Wiki folder: `wiki`
- Index file: `index.md`
- AGENTS file: `AGENTS.md`
- Max raw files per run: `20`

The plugin uses the OpenAI-compatible `/chat/completions` API.

The sync is incremental: Vault Butler records each raw file's latest modified time and size in `.vault-butler/state.json`, then only sends changed or new raw Markdown files on the next update.

## Recommended vault layout

```text
vault/
  AGENTS.md
  index.md

  .vault-butler/
    log.md
    state.json

  raw/
    slack/
    linear/
    papers/
    meeting-notes/

  wiki/
    concepts/
    projects/
    workflows/
    sources/
    decisions/
```

## Usage

Put source notes under `raw/`, then click the Vault Butler ribbon button or run:

```text
Vault Butler: Update wiki from raw changes
```

The plugin directly trusts the LLM output and writes the returned files to `wiki/`. Existing wiki files with the same paths are overwritten. Each run updates `index.md`, appends `.vault-butler/log.md`, and records sync state in `.vault-butler/state.json`.

## Notes

This is an MVP. Good next steps:

- support local Ollama/LM Studio models
- add embeddings and semantic deduplication
- add Linear/GitHub issue export
- add content hashing in addition to modified-time based incremental sync
