# Personal vault

A private MCP notebook on Cloudflare Workers + D1. The public homepage contains connection instructions only: no sign-in form, notes, or private vault status. OAuth sign-in is used only when connecting an MCP client.

- Website: https://personal-vault.evanstom273.workers.dev
- MCP endpoint: https://personal-vault.evanstom273.workers.dev/mcp
- Owner: GitHub `evanstom273`, stable account ID `60609303`

## Finish GitHub authentication (one-time, in your browser)

1. Open https://github.com/settings/applications/new.
2. Application name: `Personal Vault`.
3. Homepage URL: `https://personal-vault.evanstom273.workers.dev`.
4. Authorization callback URL: `https://personal-vault.evanstom273.workers.dev/callback`.
5. Leave device flow disabled. Register the app and generate a client secret.
6. In Cloudflare, open Workers & Pages → personal-vault → Settings → Variables and Secrets. Add both as **Secret**:
   - `GITHUB_CLIENT_ID`: the GitHub app Client ID.
   - `GITHUB_CLIENT_SECRET`: the generated GitHub client secret.
7. Save/deploy the settings. Do not put either value into source control or a chat message.
8. Add the MCP URL in ChatGPT's custom app/MCP connection UI, choose OAuth, and follow the consent and GitHub sign-in flow. If asked for OAuth client ID/secret in ChatGPT, leave them blank for dynamic registration; the GitHub app credentials belong only in Cloudflare. Availability of custom MCP apps depends on ChatGPT plan/workspace settings.

No laptop process or open browser tab is needed after authorization. Only the specified GitHub account can receive vault access. Missing GitHub credentials make authorization return 503; unauthenticated MCP access returns 401. The public homepage remains accessible.

## Tools

| Tool | Behavior |
| --- | --- |
| `get_vault_status()` | Read readiness and note count |
| `list_notes()` | Up to 1000 names and creation times; reports truncation |
| `read_note(name)` | Exact-name lookup, full content |
| `create_note(name, content)` | Create only; no overwrite; 200-character name / 100000-character content limits |
| `search_notes(query)` | Literal substring match in name/content, ASCII case-insensitive, up to 100 excerpts; reports truncation |

Names are trimmed and control characters rejected. Notes are treated as data, never rendered as executable HTML. SQL uses bound parameters. There are no delete/edit tools, AI chat interface, OpenAI API calls, or browser-stored private data.

## Architecture and authentication

The official MCP TypeScript SDK handles stateless Streamable HTTP. Cloudflare's OAuth provider handles discovery, dynamic client registration, PKCE, token refresh and revocation. Consent and upstream state are browser-bound using the library's helpers. GitHub is used solely to verify identity; its access token is not retained or passed to MCP clients. MCP bearer tokens are issued by the vault's OAuth server and scoped to this resource. They are not a shared static token.

D1 stores notes. A separate KV namespace stores OAuth registrations/grants. Tokens have a one-hour access lifetime and a 30-day grant lifetime. Reconnect after grant expiration. Provider revocation is available at the OAuth token endpoint using RFC 7009 semantics. Deleting OAuth KV records revokes connections but does not delete notes; do not clear notes to reset authentication.

Requests are limited to 600000 bytes. OAuth/MCP responses are no-store. Persisted observability is disabled to avoid collecting callback URLs or request data. No paid-plan upgrade was requested. Usage remains subject to the Cloudflare account's current plan and Workers/D1/KV quotas; public OAuth registration can consume KV operations.

## Development / future deployment

Node 24+, then:

```sh
npm ci
npm run types
npm run check
npm run build
npm test
```

`npm test` runs the bundled Worker in workerd/Miniflare with local D1/KV and mocked GitHub HTTP responses. It exercises all five tools, validation, duplicate protection, D1 persistence across restarts, wrong-owner denial, consent CSRF protection, callback cookie binding, PKCE failure, code replay, refresh, OAuth discovery and missing-secret behavior. It does not establish live GitHub or ChatGPT connectivity.

For later deployments from an authenticated cloud development environment:

```sh
npx wrangler d1 migrations apply personal-vault --remote
npm run deploy
```

Initial deployment used the connected Cloudflare API because the execution environment has no Cloudflare CLI credential. The initial schema was applied directly from `migrations/0001_notes.sql`; it is idempotent so Wrangler migrations can establish their tracking table later. Secrets must be configured before regular Wrangler deployment (declared in `secrets.required`). Never commit `.dev.vars`, `.env`, or vault exports.

## Verified deployment state, 2026-10-05

Cloudflare confirmed Worker upload and workers.dev enabled. D1 schema creation succeeded. Local type-check, bundle and integration suite passed. GitHub secrets were not present at deployment time. Public endpoint testing was blocked by the cloud environment's host allowlist; the owner chose to test the live connection themselves. No live OAuth login or ChatGPT tool execution is claimed.

For the live test, connect with OAuth, request vault status, create a uniquely named test note, list/read/search it, then reconnect and read it again. There is no delete tool, so test notes remain unless removed through D1 administration.
