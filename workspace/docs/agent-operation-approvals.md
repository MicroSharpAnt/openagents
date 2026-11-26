# Agent operation approvals — design in progress

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

This document records design decisions, not a shipped capability.

## Implementation contract (2026-11-26)

Use a separate operation-approval resource; existing conversational approvals are not execution capabilities. First runtime support is local macOS/Linux Codex with a verified read-only app-server environment. Unsupported runtime/platform fails closed in visitor DMs and never falls back to unrestricted execution. Owner's own conversations keep their existing behavior.

HTTP base `/v1/operation-approvals`; all requests include `network`, all connector requests use the workspace credential and `X-Agent-Name`; decisions require a real signed-in human. API responses use existing `{code, data}` wrappers. Wire fields are snake_case.

- GET `/context?network=…&session_id=…`: connector-only; returns `{required, owner_email, visitor_email, paused}` after validating the canonical visitor-agent pair and active member. `required` means visitor differs from owner. A missing/failed context response must not permit unrestricted visitor DM execution.
- POST base: connector creates `{network, session_id, request_key, operation:{kind:"move",root,source,destination,expected_state}}`. `root` is the configured absolute work root; `source` and `destination` are validated relative paths; `expected_state` is the connector's SHA-256 fingerprint of source and destination-parent state. Server freezes these values, computes a canonical operation digest, assigns owner from the agent record, and expires after 30 minutes. Same request key + same payload is idempotent; a different payload conflicts.
- GET base with `network` and optional `session_id`: humans see only requests in their visitor conversations or their own agents' conversations; machines only their named agent. No workspace-admin override for human visibility.
- GET `/{id}?network=…`: same visibility. Serialized record includes `id, session_id, agent_name, owner_email, visitor_email, operation, operation_digest, status, expires_at, created_at, result, paused, can_decide, can_withdraw`.
- POST `/{id}/decision`: `{network, decision:"approve"|"reject"|"withdraw"}`. Only current owner can approve/reject a pending request; only original visitor can withdraw pending/approved, before execution claim. No role or bare workspace token bypass. Ownership change invalidates old approvals.
- POST `/{id}/claim`: connector sends `{network,operation_digest}`. Single atomic transition approved→executing, only while unpaused and unexpired, ownership still matches. Returns a random `execution_token` once. Repeated/concurrent claims never grant another token; lost claim response must not trigger execution or automatic retry.
- POST `/{id}/result`: `{network,execution_token,status:"succeeded"|"failed"|"invalidated",result}`. Accept only the original claim token and agent. Repeated identical result is idempotent; no result can grant another execution. Invalidated means relevant filesystem state changed; a fresh approval is required.
- Pending/approved expiration must be applied on reads/decisions/claims. Executing records with lost completion are displayed as outcome unconfirmed; no automatic rerun.

Connector boundary: do not expose workspace tokens or approval/claim endpoints to the model. A trusted host handles the dynamic move tool, freezes paths/fingerprint before requesting approval, polls while pending/taken over, claims once, rechecks the filesystem immediately before executing, and reports the result. Permit only moves inside the configured work root, reject symlinks and existing destinations, prohibit moving the root or a parent into itself, and use a no-overwrite native rename primitive (not shell interpolation). Any unsupported primitive fails closed. Once a claim has been consumed, a local durable journal prevents rerunning it after reconnect/restart. A failed or lost completion never causes replay.

Runtime: isolated Codex config, read-only/no-network native tools, external apps/plugins/MCP disabled, all native escalation denied, no unrestricted fallback. Host responds to dynamic tool calls only from the matching live thread/turn. Visitor mode does not reuse unrestricted owner threads. Record results from protocol events and actual filesystem state, never rely on the model saying it executed.

UI: a dedicated operation card in the current DM shows agent, requester, exact root/source/destination, status and expiration. Owner gets Approve once/Reject; visitor gets Withdraw; everyone sees final status. Approved+paused reads Waiting for agent resume. The owner receives an in-app pending-count affordance linking to the correct conversation. Polling/reconnect refreshes state and does not execute an action.

## Confirmed test seams

User confirmed backend HTTP permissions/state tests, connector execution-interface tests observing real filesystem effects and repeated execution protection, frontend interaction tests, and a final two-account end-to-end check. Use red→green slices at these public boundaries.

## Implementation task graph

All tasks use this frozen contract and are independently executable; integration depends on all three.

1. Backend operation approval API + storage + HTTP tests; owns backend router/service/model/migration/tests.
2. Trusted Codex operation execution + native no-overwrite helper + execution tests; owns agent-connector only.
3. DM operation cards + pending owner affordance + interaction tests; owns workspace frontend only.
4. Integrate, run local end-to-end verification, review and fix issues. No hosted production deployment is part of this change.
