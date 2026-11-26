# Agent operation approvals

## Confirmed behavior

- Only the authenticated agent owner can approve a specific operation requested in a visitor conversation. Chat text is not an approval credential.
- Approval applies to the exact operation and parameters, not continuing authority for the visitor. Changed parameters require another request.
- An approval resumes the pending operation automatically. While the conversation is taken over, an approved operation waits until the owner resumes the agent.
- Visitors may see approval status and withdraw their own pending requests. Rejected, expired, or withdrawn requests must not execute.
- Repeated approval clicks or reconnects must not cause duplicate execution.
- The execution boundary must enforce authorization; an approval card and model instructions alone do not provide this guarantee.

## Additional confirmed scope

- Initial supported operations: file rename/move, before expanding to edits, deletion, and arbitrary commands. Other write operations are unavailable in this mode.
- Expiration: 30 minutes; revalidate the relevant filesystem state before execution and request approval again if it changed.
- Notifications: application unread indicators and conversation cards, without external messaging.

## Feasibility gate

Verify a controlled Codex execution path that pauses before side effects, receives owner decisions, and enforces the approved scope. Prototype this boundary before committing to implementation of the approval UI. Existing unrestricted execution paths must not remain available to visitor-triggered runs under this policy.

Implemented on `codex/owner-operation-approvals`. Local installation and hosted deployment are separate from the source implementation.

## Implementation contract (2026-11-26)

Use a separate operation-approval resource; existing conversational approvals are not execution capabilities. First runtime support is local macOS/Linux Codex with a verified read-only app-server environment. Unsupported runtime/platform fails closed in visitor DMs and never falls back to unrestricted execution. Owner's own conversations keep their existing behavior.

HTTP base `/v1/operation-approvals`; all requests include `network`, all connector requests use the workspace credential and `X-Agent-Name`; decisions require a real signed-in human. API responses use existing `{code, data}` wrappers. Wire fields are snake_case. List responses use `data: {requests: [...]}`; single/create/decision/result responses use `data: record`; claim returns `data: {...record, execution_token}`.

- GET `/context?network=…&session_id=…`: connector-only; returns `{required, owner_email, visitor_email, paused}` after validating the canonical visitor-agent pair and active member. `required` means visitor differs from owner. A missing/failed context response must not permit unrestricted visitor DM execution.
- POST base: connector creates `{network, session_id, request_key, operation:{kind:"move",root,source,destination,expected_state}}`. `root` is the configured absolute work root; `source` and `destination` are validated relative paths; `expected_state` is the connector's SHA-256 fingerprint of source and destination-parent state. Server freezes these values, computes a canonical operation digest, assigns owner from the agent record, and expires after 30 minutes. Same request key + same payload is idempotent; a different payload conflicts.
- GET base with `network` and optional `session_id`: humans see only requests in their visitor conversations or their own agents' conversations; machines only their named agent. No workspace-admin override for human visibility.
- GET `/{id}?network=…`: same visibility. Serialized record includes `id, session_id, agent_name, owner_email, visitor_email, operation, operation_digest, status, expires_at, created_at, result, paused, can_decide, can_withdraw`.
- POST `/{id}/decision`: `{network, decision:"approve"|"reject"|"withdraw"}`. Only current owner can approve/reject a pending request; only original visitor can withdraw pending/approved, before execution claim. No role or bare workspace token bypass. Ownership change invalidates old approvals.
- POST `/{id}/claim`: connector sends `{network,operation_digest}`. Single atomic transition approved→executing, only while unpaused and unexpired, ownership still matches. Returns a random `execution_token` once. Repeated/concurrent claims never grant another token; lost claim response must not trigger execution or automatic retry. An explicit HTTP 409 may be followed by a state read; only a still-approved request may attempt another claim before expiry, waiting while paused and using a bounded polling delay if already resumed. Executing/consumed requests and ambiguous transport failures must never retry.
- POST `/{id}/result`: `{network,execution_token,status:"succeeded"|"failed"|"invalidated",result}`. Accept only the original claim token and agent. Result is a human-readable string of at most 4096 characters or null. Repeated identical result is idempotent; no result can grant another execution. Invalidated means relevant filesystem state changed; a fresh approval is required.
- Pending/approved expiration must be applied on reads/decisions/claims. Executing records with lost completion are displayed as outcome unconfirmed; no automatic rerun.

Connector boundary: do not expose workspace tokens or approval/claim endpoints to the model. A trusted host handles the dynamic move tool, freezes paths/fingerprint before requesting approval, polls while pending/taken over, claims once, rechecks the filesystem immediately before executing, and reports the result. Permit only moves inside the configured work root, reject symlinks and existing destinations, prohibit moving the root or a parent into itself, and use a no-overwrite native rename primitive (not shell interpolation). Any unsupported primitive fails closed. Once a claim has been consumed, a local durable journal prevents rerunning it after reconnect/restart. A failed or lost completion never causes replay.

Runtime: isolated Codex config, read-only/no-network native tools, external apps/plugins/MCP disabled, all native escalation denied, no unrestricted fallback. Host responds to dynamic tool calls only from the matching live thread/turn. Visitor mode does not reuse unrestricted owner threads. The trusted connector normalizes peer-format DM identifiers to the canonical human/agent pair for authorization while preserving the reply transport address. Each isolated visitor turn receives bounded, same-conversation history from before the triggering message; unrelated conversations and credentials are excluded. Record results from protocol events and actual filesystem state, never rely on the model saying it executed.

UI: a dedicated operation card in the current DM shows agent, requester, exact root/source/destination, status and expiration. Owner gets Approve once/Reject; visitor gets Withdraw; everyone sees final status. Approved+paused reads Waiting for agent resume. The owner receives an in-app pending-count affordance linking to the correct conversation. Polling/reconnect refreshes state and does not execute an action.

## Confirmed test seams

User confirmed backend HTTP permissions/state tests, connector execution-interface tests observing real filesystem effects and repeated execution protection, frontend interaction tests, and a final two-account end-to-end check. Use red→green slices at these public boundaries.

## Implementation task graph

All tasks use this frozen contract and are independently executable; integration depends on all three.

1. Backend operation approval API + storage + HTTP tests; owns backend router/service/model/migration/tests.
2. Trusted Codex operation execution + native no-overwrite helper + execution tests; owns agent-connector only.
3. DM operation cards + pending owner affordance + interaction tests; owns workspace frontend only.
4. Integrate, run local end-to-end verification, review and fix issues. No hosted production deployment is part of this change.

## Protocol feasibility evidence

Local Codex 0.151.0 app-server verified on macOS using a disposable workspace and isolated authentication/config directory: native writes denied; host-only credential-directory canary reads denied; real dynamic move request suspended without changing files; host approval/result continued the same turn; rejection left files unchanged; a real model shell-write attempt failed. An explicit escalation request was also received and declined in the read-only probe. The throwaway protocol prototype is preserved on `codex/prototype-operation-approvals` at `14a645f0`; production execution is independently covered by filesystem and end-to-end checks.

The restricted profile grants only minimal runtime reads, workspace reads and the real Codex binary directory, with command network access disabled and shell environment inheritance disabled. Spawn the canonical binary path: granting the canonical directory but spawning via a symlink caused helper startup to fail. Keep code_mode_host enabled for this CLI build; disabling it prevented the dynamic-tool request. External apps, multi-agent, remote-plugin and skill-MCP auto-install features were disabled. Code-mode command evidence appears in rawResponseItem events, not necessarily commandExecution items.

Protocol references: https://learn.chatgpt.com/docs/app-server and https://learn.chatgpt.com/docs/permissions . Implementation tracking: https://github.com/MicroSharpAnt/openagents/issues/2 .

## Validation and delivery status

- Frontend full suite: 1,277 passed; desktop production bundle builds.
- Backend full suite: 2,451 passed, 31 failed, 78 skipped, 6 errors. The same 31 failures and 6 errors reproduce on the pre-feature baseline (2,444 passed); no new failing case. Focused approval/owner tests pass.
- Connector approval/runtime/dispatch tests pass. The wider connector run retains two reproduced baseline failures (DeepSeek binary resolution and Claude sign-in readiness); missing worktree dependencies were repaired before rerunning affected groups.
- Isolated PostgreSQL migration chain 001–104 passes. Three-account browser checks cover owner-only decisions, visitor withdrawal, unrelated-user denial, takeover/resume, real native directory movement, rejection, changed-state invalidation, duplicate prevention and eight concurrent execution claims with exactly one winner. Pending notifications navigate to the matching conversation.
- Real Codex app-server execution was checked after the runtime refactor, including waiting for approval, a single claim, native movement and completion reporting. Real signed-in HTTP messages were also polled through the actual event-to-message conversion and shared dispatch gate: visitor execution is restricted and owner execution remains available. Continuous-DM tests cover bounded prior human/agent/owner context and exclusion of foreign/future/status events.

This feature requires backend migration 104, the updated frontend, and the updated connector together. The existing local app/backend installation has not been upgraded by these source implementation checks. First support is native local Codex on macOS/Linux; unsupported visitor runtimes fail closed. Custom provider endpoints and script/WSL Codex wrappers are not supported in this first release.
