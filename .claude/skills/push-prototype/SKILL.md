---
name: push-prototype
description: "Push an HTML/JS prototype (single file or multi-file) from the local filesystem into this repo's Web-Doc instance, so a product owner gets a shareable sandboxed preview URL. Use when asked to publish, push, upload, or share an HTML/JS prototype to Web-Doc."
---

# Push a prototype to Web-Doc

Web-Doc has a built-in MCP server for exactly this. Use its MCP tools — don't hand-roll REST/curl calls.

## One-time setup (tell the user if missing)

1. Web-Doc instance must be running (`docker compose up -d --build` in this repo, or the user's deployment URL).
2. User logs into the Web-Doc web UI and mints a personal MCP token: **Settings → MCP Tokens → Create**.
3. Register the server (already scaffolded in `.mcp.json` at repo root — just needs env vars):
   ```bash
   export WEBDOC_URL=http://127.0.0.1:8787   # or the deployed origin
   export WEBDOC_MCP_TOKEN=<token from step 2>
   ```
4. Restart Claude Code (or `/mcp reload`) so the `web-doc` MCP server connects.

## Pushing a prototype

Given local files for the prototype:

- **Single HTML file** (no external assets): call `create_document` with the file content as the initial HTML. This creates the doc and writes `index.html` in one step.
- **Multi-file** (HTML + JS/CSS/images/fonts): zip the prototype's files with `index.html` at the zip root, base64-encode it, then call `create_document` (folder/empty doc) followed by `upload_zip_base64` — or if the doc already exists, call `upload_zip_base64` directly to replace its contents.
- To update a single file in an existing multi-file doc without touching the rest, use `upload_html` with the target `path`.

After pushing, resolve the preview URL for the user:

```
{WEBDOC_URL}/doc/v/{docId}
```

(`docId` comes back from `create_document`'s response. Use `/v/{docId}` instead of `/doc/v/{docId}` if the instance isn't behind the `/doc/` nginx prefix — check `VITE_BASE` in `docker-compose.yml`.)

## Notes

- Zip uploads only accept whitelisted extensions (html/js/css/png/jpg/svg/woff2/...) and are capped at 50 MB — see README "Security Notes".
- `list_documents` / `get_document` are useful to find an existing doc's ID before overwriting it, instead of creating a duplicate.
- This MCP server has no "list folders and ask which one" UX — if the user didn't specify a target folder/parent, create at the root and tell them where it landed.
