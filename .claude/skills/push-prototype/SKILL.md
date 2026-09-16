---
name: push-prototype
description: "Push an HTML/JS prototype (single file or multi-file) from the local filesystem into this repo's Web-Doc instance, so a product owner gets a shareable sandboxed preview URL. Use when asked to publish, push, upload, or share an HTML/JS prototype to Web-Doc."
---

# Push a prototype to Web-Doc

Web-Doc has a built-in MCP server for exactly this. Use its MCP tools — don't hand-roll REST/curl calls.

Web-Doc is multi-user now: every doc has an owner, `/` requires login, and an MCP
token is tied to whoever created it (`POST /api/mcp/tokens` while logged in). A doc
created through this MCP server is **private to that token's owner** by default —
there's no MCP tool to mint a public share link, so pushing a prototype does not by
itself make it viewable by anyone else.

## One-time setup (tell the user if missing)

1. Web-Doc instance must be running (`docker compose up -d --build` in this repo, or the user's deployment URL).
2. User logs into their own Web-Doc account (registers one at `/` if they don't have
   one yet) and mints a personal MCP token: sidebar header's wand icon (**AI
   Settings**) → **MCP Access** tab → Create.
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

## Who can actually open that link

- **The MCP token's owner**, logged into the Web-Doc UI as themselves, can open it
  directly — it's their own doc.
- **Anyone else** (e.g. handing the link to a product owner who doesn't have/want a
  Web-Doc account) needs a public share link instead. There's no MCP tool for this —
  tell the user to open the doc in the Web-Doc UI (as its owner) and click **Share**,
  which gives a `{WEBDOC_URL}/doc/s/{token}` link that works with no login. Don't
  invent a way to do this over the MCP/REST API on the user's behalf.

## Notes

- Zip uploads only accept whitelisted extensions (html/js/css/png/jpg/svg/woff2/...) and are capped at 50 MB — see README "Security Notes".
- `list_documents` / `get_document` only return docs owned by the MCP token in use —
  useful for finding an existing doc's ID before overwriting it, instead of creating a
  duplicate, but they won't show another user's docs.
- This MCP server has no "list folders and ask which one" UX — if the user didn't specify a target folder/parent, create at the root and tell them where it landed.
