# Pulse Threat Model — v1

Updated: 2026-04-18 (Task #2 security hardening).

## Trust boundaries

| Zone | Description | Auth |
| --- | --- | --- |
| Public internet | Survey respondents loading magic-link pages | None (single-use opaque token) |
| Authenticated UI | FullStack assessors using the cockpit | Clerk session |
| Server → DB | Drizzle ORM over `DATABASE_URL` | Replit-managed Postgres |
| Server → 3rd-party | Connector calls to GitHub / GitLab / Jira / Linear / CI / AI tooling | Per-engagement encrypted PAT |

## Assets

1. **Engagement data** — survey responses, interview notes, scoring, deliverables. Confidential to the client + the engagement members.
2. **Connector PATs** — long-lived credentials for client-owned source-control / ticketing systems. High-value if leaked.
3. **Magic-link tokens** — unauthenticated bearer tokens that expose a single survey response slot.
4. **Export bundles** — ZIPs / JSON delivered to client sponsors; signed so the client can detect tampering in transit.

## Controls (implemented in v1)

### Authentication and authorization
- Clerk middleware mounted globally; `routes/index.ts` enforces `requireAuth` on every non-public path and `requireEngagementMember` on every `/engagements/:id/...` path before any handler runs (regex-matched at the wrapper layer).
- Per-resource guards (`requireConnectorMember`, `requireInterviewMember`, `requireArtifactMember`, `requireEvidenceMember`) resolve the parent engagement and re-check membership for nested resources like `/connectors/:connectorId/...`.
- Member management routes (`POST/DELETE /engagements/:id/members`) require `requireEngagementOwner`. The cockpit also hides the invite UI from non-owners.

### Magic-link survey tokens (`survey_invites`)
- Tokens are 24-byte base64url strings issued at invite creation. Only the **HMAC-SHA256 hash** is persisted (`token` column); the plaintext is returned to the assessor exactly once in the POST response and never readable again.
- Server-side lookup hashes the incoming URL token before querying, so a database snapshot leak does not yield live magic links.
- Each invite carries `expires_at` (default 30 days; configurable via `PULSE_INVITE_TTL_MS`). Expired or unknown tokens return a generic 404 ("Link is invalid or has expired") to avoid revealing which case occurred.
- Listing invites (`GET /engagements/:id/survey/invites`) strips the stored hash from responses.
- Anonymity floor (≥5 respondents) is enforced server-side before per-team aggregates leave the API.

### Connector PAT storage
- `encrypted_token` is AES-256-GCM ciphertext. Per-purpose 32-byte keys are derived from `SESSION_SECRET` via HKDF-SHA256 (label `pulse-token-v1`); operators can override with `PULSE_TOKEN_KEY` (hex / base64 32-byte).
- Stored format `v1:<iv>:<authTag>:<ciphertext>` (all base64url). Legacy base64 rows from the prototype are still readable for backward-compat.
- Plaintext tokens never leave the server. The cockpit only sees `maskToken` previews (`••••XXXX`).

### SSRF guard on connector base URLs
- GitLab self-managed and Jira Cloud / Server connectors accept user-supplied `baseUrl`. Both POST and PATCH validate via `checkSafeUrl`, which rejects:
  - non-http(s) schemes (`file:`, `gopher:`, …)
  - hostnames `localhost`, `*.localhost`, `*.internal`, `*.local`, `metadata`, `metadata.google.internal`
  - IPv4 in 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (incl. cloud metadata 169.254.169.254), 100.64/10, 0/8, 224/4, 240/4
  - IPv6 `::1`, `::`, `fe80::/10` link-local, `fc00::/7` ULA, IPv4-mapped private addresses
- Defense-in-depth: `lib/connectors.ts` re-runs `assertSafeUrl` at fetch time before each outbound call so stored rows that pre-date the guard cannot reach internal hosts.
- Known gap: we do not currently resolve DNS or pin to the resolved IP, so DNS-rebinding attacks against a host that initially resolves to a public IP and then to a private one are not blocked. Production should sit behind an egress proxy or pin DNS.

### Export signing
- Export snapshots are signed with HMAC-SHA256 using a key derived from `SESSION_SECRET` via HKDF (label `pulse-export-v1`); override with `PULSE_EXPORT_KEY`.
- Response includes `signatureAlgorithm` and `keyFingerprint` (first 16 hex chars of SHA-256 of the key) so recipients can confirm which key signed their bundle without learning the key itself.
- `POST /exports/:exportId/verify` re-computes the HMAC over a submitted snapshot JSON and returns `{ ok, expectedAlgorithm, keyFingerprint }`. Constant-time hex comparison.

### Activity log
- Every state-changing route writes an `activity_events` row attributing the action to the authed user. Surfaces in the engagement timeline.
- Magic-link respondents are anonymous by design; `activity_events.actor*` are nullable and the public submit route does NOT write an activity event (would re-link the respondent to a team).

## Residual risk / deferred to later tasks

| Risk | Status | Plan |
| --- | --- | --- |
| Root signing/encryption key rotation | Manual via env var override; legacy ciphertexts decrypt only with the old key | KMS integration in Task #3 (audit log & observability) follow-up |
| DNS rebinding on connector base URLs | Not blocked | Document + recommend egress proxy in production |
| Rate-limiting on magic-link respondent endpoint | None | Add IP-based limiter in Task #5 (survey distribution polish) |
| Audit trail for member role changes | Logged via activity feed; no immutable WORM store | Task #3 |
| File-upload virus scanning on artifact vault | Not implemented | Task #4 (artifact ingestion hardening) |

## Dev-mode safety
If `SESSION_SECRET` is unset the server falls back to a known-insecure dev string and logs derive-from-default keys. **This must not happen in production**; deployment should fail closed when `SESSION_SECRET` is missing. Tracked as a follow-up.
