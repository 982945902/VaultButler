# Vault Butler

An MVP Obsidian plugin that turns your vault into an **LLM-maintained Markdown wiki**.

It is designed for this workflow:

```text
raw/       = immutable source notes
wiki/      = AI-synthesized knowledge base
index.md   = navigation map
log.md     = append-only maintenance log
AGENTS.md  = rules for the AI organizer
```

## What it does

Commands:

- **Vault Butler: Create AGENTS.md template**
- **Vault Butler: Ingest current note into wiki**
- **Vault Butler: Organize raw folder into wiki**
- **Vault Butler: Rebuild wiki index locally**
- **Vault Butler: Toggle preview mode**

The AI writes only to:

- your configured `wiki/` folder
- your configured `index.md`
- your configured `log.md`

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
- Log file: `log.md`
- AGENTS file: `AGENTS.md`

The plugin uses the OpenAI-compatible `/chat/completions` API.

## Recommended vault layout

```text
vault/
  AGENTS.md
  index.md
  log.md

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
    drafts/
```

## Safe usage

Start with **Preview mode enabled**.

In preview mode, the plugin writes one preview file under:

```text
wiki/drafts/
```

It will not modify your real wiki pages until you disable preview mode.

## Notes

This is an MVP. Good next steps:

- add a side panel to approve file-by-file changes
- support local Ollama/LM Studio models
- add embeddings and semantic deduplication
- add Linear/GitHub issue export
- add automatic source fingerprinting so the same raw file is not ingested twice
