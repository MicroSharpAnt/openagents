# Agent owner participation in direct conversations

## Confirmed behavior

- An authenticated agent owner can list and read each visitor-agent conversation, including history and live messages.
- The owner participates under their own human identity, with their avatar, name and an Agent owner badge; messages remain in the original visitor conversation.
- Every visitor conversation is isolated from other visitors. Ownership, not workspace administrator status or a shared agent grant, authorizes oversight.
- A notice explains that the agent owner can view and participate.
- Viewing does not pause the agent. Take over pauses automatic replies for just this conversation; Resume restores automatic replies to new messages.
- Cross-device state is stored on the server.

## Validation seams (confirmed)

HTTP API tests cover identity, listing/history/incremental updates, isolation and takeover/resume. Frontend interaction tests cover entry, owner identity and controls. A local end-to-end check supplements them.

## Delivery scope

Implement in the self-hostable core. Do not deploy or run production migrations without separate authorization.

## API and storage

- `GET /v1/events/conversations` includes `owner_email`, `can_manage`, and `paused` for visitor conversations. Existing polling and both event streams apply owner-aware visibility.
- `GET /v1/direct-conversations/state?network=…&session_id=dm:…` returns the current owner capabilities and takeover state for the visitor or owner.
- `PATCH /v1/direct-conversations/takeover` accepts `{network, session_id, paused}` from the authenticated owner only.
- An owner sends a normal direct `workspace.message.posted` event addressed to the visitor, with `metadata.dm_conversation` naming the original visitor-agent pair. The server authenticates ownership and stamps `dm_agent`/`dm_owner`; the event source remains the real human.
- Migration **103** adds nullable `direct_thread_links.takeover_owner` and updates the PostgreSQL DM-summary trigger to group owner replies in the original conversation. Apply migrations before running the updated backend. No historical migration was rewritten.
- Takeover suppresses new agent dispatch and rejects agent messages posted while paused. It does not terminate a model process already running on another device. Resume applies to new messages; paused visitor messages are not replayed.

## Validation (2026-11-26)

- 122 focused backend tests pass, including both SQLite and PostgreSQL query semantics, privacy, stream access, takeover, quotes, and existing cloud-agent DM context.
- Frontend full suite: 1261 passed with three pre-existing header-fixture failures; those three pass after repairing the fixture. TypeScript checking passes.
- Isolated PostgreSQL: full Alembic migration chain through 103 passes. Three independent Chrome sessions pass ten end-to-end checks covering owner entry/history, visitor isolation, takeover synchronization, blocked late replies, unaffected other visitor, human owner badge, original conversation identity, reload persistence, resume, and exact trigger-maintained summaries.
- Backend full suite: 2437 passed, 78 skipped, 38 failures and six setup errors on the initial run. Comparison with a separate task-start-code run reproduced all failures except seven synthetic-query fixtures missing the newly consumed metadata column; those fixtures were updated and all seven pass in the focused run. Existing failures include unavailable integrations/network-dependent browser tests and stale initial-schema snapshots; the full suite is not green.
- Standards review: no blocking documented-rule violations; three maintainability/performance suggestions addressed. Spec review: no missing or incorrect requirements found.

No production deployment or production database migration was performed.
