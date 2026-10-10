# Personal vault

A private Markdown notebook on Cloudflare Workers + D1. Open the website to write, or connect ChatGPT and other MCP clients to the same notes.

- Notebook: https://personal-vault.evanstom273.workers.dev
- MCP endpoint: https://personal-vault.evanstom273.workers.dev/mcp
- Source: https://github.com/evanstom273/personal-vault (the `main` branch)
- Owner: GitHub `evanstom273`, stable account ID `60609303`

## Browser notebook

Open the root URL and choose **Open with GitHub**. Only the configured owner can access notes. Browser login reuses the existing GitHub OAuth app, credentials and `/callback` URL; an existing installation needs no additional GitHub setup.

The compact note explorer supports name/content search. Create and edit Markdown, rename a note by changing its name, switch to a sanitized reading preview, follow `[[exact note name]]` links and backlinks (`[[Name|alias]]` and `[[Name#heading]]` also count as backlinks), download an individual `.md` file, or move a note to the trash after confirmation. **History** lists the open note's earlier versions; view one and restore it into the editor, then save. **Trash** lists trashed notes, each with **Restore**. **Export .zip** downloads the whole vault (see Export). Names can contain `/` to visually group related notes; there is no separate folder tree. On phones, the **Notes** button opens the explorer. **Ctrl/Cmd+S** saves; **Ctrl/Cmd+K** focuses search.

Saving writes to D1, shared with the MCP connector. Every save, from the browser or MCP, first copies the previous version into revision history (`note_revisions`), so earlier content is never lost; a rename carries the note's history with it. Deleting, from the browser or MCP, moves a note to the trash: it disappears from listing, search and reading but keeps its content and history, and can be restored. A trashed note's name stays reserved until it is restored. Nothing is permanently deleted. Rename is browser-only. Revision checks reject stale saves and deletes rather than overwrite another revision. Copy a conflicting draft before using **Reload**, which discards the local draft. Renaming does not rewrite wiki links in other notes.

### Export

While signed in, `/api/export` downloads `personal-vault-YYYY-MM-DD.zip` with every note as a plain Markdown file: `notes/` for live notes, `trash/` for trashed notes and `history/<note>/r<n>.md` for earlier versions. A `/` in a note name becomes a folder. File names are made safe for common file systems (illegal characters become `-`, case clashes get a ` (2)` suffix), so `vault.json` records each note's exact name, path, timestamps and revision. Files are stored uncompressed to keep Worker CPU time low. For a raw database backup, use `npx wrangler d1 export` (see below).

IndexedDB stores a per-browser cache of opened notes and unsaved drafts. Drafts are saved locally as you type, while **Save** persists them to D1. Browser sessions last seven days. Session expiration locks the notebook and clears the note cache, but keeps drafts for restoration after the owner signs in again. Explicit **Sign out** clears both cached notes and drafts from that browser. Browser storage can be unavailable or cleared, so it is not a backup.

This is not a full offline app: a page reload, login, listing, search and server saves need a connection. An already-open session can fall back to a previously cached note while offline. There is no service worker or offline synchronization queue. The notebook provides a focused subset of Obsidian-style Markdown workflows, not full Obsidian parity, plugin support or Obsidian vault synchronization. There is no AI chat interface or OpenAI API use.

## GitHub setup for a new installation

Existing credentials work for both browser login and MCP authorization. For a fresh installation:

1. Open https://github.com/settings/applications/new.
2. Set the application name to `Personal Vault` and homepage to `https://personal-vault.evanstom273.workers.dev`.
3. Set the authorization callback URL to `https://personal-vault.evanstom273.workers.dev/callback`. Leave device flow disabled.
4. Register the app and generate a client secret.
5. In Cloudflare, open Workers & Pages → personal-vault → Settings → Variables and Secrets. Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as **Secret**, then save/deploy. Never put their values in source control or chat.
6. Open the notebook and sign in with the owner account, or add the MCP URL in your client's custom app/MCP connection UI and choose OAuth.

If ChatGPT asks for OAuth client ID/secret, leave them blank for dynamic registration; the GitHub credentials belong only in Cloudflare. Custom MCP availability depends on ChatGPT plan/workspace settings. No laptop process or open browser tab is required for MCP access after authorization. Missing GitHub credentials make authorization return 503; unauthenticated API/MCP access returns 401.

## MCP tools

| Tool | Behavior |
| --- | --- |
| `get_vault_status()` | Read readiness, note count and trash count |
| `list_notes()` | Up to 1000 names and creation times; reports truncation |
| `read_note(name)` | Exact-name lookup, full content, `revision` and `updated_at` |
| `create_note(name, content)` | Create only; no overwrite; 200-character name / 100000-character content limits |
| `search_notes(query)` | Literal substring match in name/content, ASCII case-insensitive, up to 100 excerpts; reports truncation |
| `update_note(name, content, expected_revision)` | Replace content; rejected unless `expected_revision` (from `read_note`) is current; previous version kept in history |
| `append_to_note(name, content)` | Append on a new line; no revision needed; previous version kept in history; rejected if the note would exceed 100000 characters |
| `delete_note(name)` | Move to the trash; content and history kept |
| `restore_note(name)` | Bring a note back from the trash unchanged |
| `list_trash()` | Trashed notes, most recent first, up to 1000, with excerpts |
| `get_linked_notes(name)` | Outgoing `[[wikilinks]]` with status exists/missing/trashed, and backlinks (up to 100) with surrounding text |
| `list_note_revisions(name)` | Earlier versions, newest first, up to 200, with excerpts |
| `read_note_revision(name, revision)` | Full content of one version; restore it by passing it to `update_note` |

Names are trimmed and control characters rejected. SQL uses bound parameters. Markdown preview is sanitized; executable HTML, inline styling, forms and images are excluded. Listing, reading, searching and writing ignore trashed notes. There is no MCP rename tool and no permanent delete.

## Architecture and authentication

The Worker serves the browser shell at `/`, its bundled script at `/app.js`, authenticated browser endpoints under `/api/`, and stateless Streamable HTTP at `/mcp` through the official MCP TypeScript SDK. Browser notes and MCP notes share the same D1 `notes` table.

GitHub verifies owner identity. Browser authorization uses PKCE and browser-bound, single-use login state; D1 stores hashed browser session tokens. The session cookie is Secure, HttpOnly and SameSite=Lax. Browser mutations require a same-origin request and session-bound CSRF token. GitHub access tokens are not retained or passed to MCP clients.

Cloudflare's OAuth provider handles MCP discovery, dynamic client registration, PKCE, token refresh and revocation. A separate KV namespace stores OAuth registrations/grants. MCP bearer tokens are resource-scoped, with a one-hour access lifetime and a 30-day grant lifetime; reconnect after grant expiration. Provider revocation is available at the token endpoint using RFC 7009 semantics. Deleting OAuth KV records revokes MCP connections without deleting notes. Browser sign-out revokes its browser session, independently of MCP grants.

Requests are limited to 600000 bytes. Authentication, API and MCP responses are no-store. Persisted observability is disabled to avoid collecting callback URLs or request data. No paid-plan upgrade was requested. Usage remains subject to current Workers/D1/KV quotas; public OAuth registration can consume KV operations.

## Development and deployment

Use Node 24+:

```sh
npm ci
npm run types
npm run check
npm run build
npm run test
npm run test:browser
```

`build` bundles the browser app and performs a Worker dry run. Both test scripts build first. `test` uses workerd/Miniflare, local D1/KV and mocked GitHub HTTP responses to exercise MCP tools, revision history, validation, persistence, OAuth and browser API/session protections; `tests/migrations.test.mjs` checks that every migration after the two deployed ones leaves existing rows unchanged. `test:browser` uses Playwright with Chromium at `/usr/bin/chromium` (override with `CHROMIUM_PATH`) against the local Worker. It covers browse/search, links/backlinks and alias links, create/save/trash, restoring from history and from the trash, export, draft restoration after reload and session expiry, conflicts, mobile layout and sign-out. These local tests do not verify live GitHub or ChatGPT connectivity.

From an authenticated cloud development environment:

```sh
npx wrangler d1 migrations apply personal-vault --remote
npm run build
npm run deploy
```

Both `0001_notes.sql` and `0002_browser.sql` have been applied to the remote D1 database and recorded in `d1_migrations`. The browser migration adds revisions, update timestamps and browser authentication tables; the existing note count was preserved. Do not run the second migration manually again: its column additions are not idempotent. Use migration tracking for subsequent deployments.

### Applying a new migration

Migrations are additive (new tables and columns), so the running Worker keeps working against the new schema. Apply them before deploying code that needs them. Take a backup and note a Time Travel bookmark first:

```sh
npx wrangler d1 time-travel info personal-vault
npx wrangler d1 export personal-vault --remote --output ~/vault-backups/personal-vault-$(date +%F).sql
npx wrangler d1 migrations list personal-vault --remote
npx wrangler d1 migrations apply personal-vault --remote
npm run build && npm run deploy
```

`migrations list` must show only the new files as pending. To roll the database back, use `npx wrangler d1 time-travel restore personal-vault --bookmark=<bookmark>`; to roll back code only, use `npx wrangler rollback`. Keep exports outside the repository.

The connected Cloudflare API was used when this environment lacked CLI credentials. Keep source changes on `main`. Secrets must exist before regular Wrangler deployment (`secrets.required`); never commit `.dev.vars`, `.env` or vault exports.

## Verification status, 2026-10-06 (Europe/London)

Cloudflare confirmed the browser notebook deployment at 100% traffic (version `9dec1408-f031-4ef8-b9d8-00376bd3dedb`, source commit `12824af` on `main`). Existing GitHub secrets and workers.dev routing were preserved. Both remote migrations are complete. `npm run check`, `npm run build`, `npm run test` and `npm run test:browser` passed. These automated checks exercise the browser against Miniflare, not a live GitHub session. Live browser login and live ChatGPT tool execution are not claimed as verified.

Sign in at the notebook root, save a uniquely named test note, and use your existing MCP connection to read/search the same note. No connector recreation is required. Edit it in the browser and read it again through MCP. Delete the test note in the browser when finished.
