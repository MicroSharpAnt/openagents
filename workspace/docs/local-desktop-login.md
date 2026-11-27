# Local desktop password login

For local development, the backend can authenticate operator-provisioned
local accounts without Firebase or the hosted account service. This is opt-in;
existing deployments keep their authentication behavior. Bind the development
API to loopback. This mode is not a public registration service.

Configure the backend environment:

- `LOCAL_AUTH_ENABLED=1`
- `LOCAL_AUTH_EMAIL=developer@example.test`
- `LOCAL_AUTH_DISPLAY_NAME=Local Developer` (optional)
- `LOCAL_AUTH_PASSWORD_HASH=<salt hex>:<scrypt digest hex>`
- `WORKSPACE_SESSION_SECRET=<random secret, at least 32 bytes>`

The password hash uses a random 16-byte salt and scrypt with `N=16384, r=8,
p=1, dklen=32`. Keep the password and session secret outside version control.
For example, Node's `crypto.scryptSync(password, salt, 32)` uses these parameters.
No database migration is required for this mode.

For multiple users, set `LOCAL_AUTH_USERS_FILE` to a readable JSON file in the
backend container (mount it read-only). When set, this file **replaces** the
single-account environment settings, so include the existing account too:

```json
[
  {"email": "developer@example.test", "display_name": "Developer", "password_hash": "<salt hex>:<digest hex>"},
  {"email": "tester@example.test", "display_name": "Tester", "password_hash": "<salt hex>:<digest hex>"}
]
```

Use a separate random salt and password for each account. Keep this file outside
version control with restricted permissions. Missing, malformed or duplicate
accounts fail closed. Changes to the file are read on the next login; issued
sessions retain their normal lifetime. Account provisioning does not grant
workspace access: the owner creates an email-bound `member` invitation through
`POST /v1/workspaces/{slug}/invites`, and the new user's session accepts it through
`POST /v1/invites/{token}/accept`. A targeted channel invite also grants access to
that conversation; other private conversations keep their access rules.

Start the source desktop client with:

```sh
OPENAGENTS_LOCAL_AUTH=1 OPENAGENTS_WORKSPACE_BUNDLE_FEED=off \
  npm --prefix packages/launcher run dev
```

Set Settings → Network → Workspace endpoint to the local API origin, for example
`http://127.0.0.1:8000`. Include both `openagents://workspace` and
`http://127.0.0.1:8000` in backend `CORS_ORIGINS`: the desktop bridge currently
uses the derived web origin for preflight requests. On the Workspace side, use the email/password sign-in
form with the provisioned credentials. Local mode posts only to that endpoint's
`POST /v1/auth/local-session`; it does not fall back to a hosted identity service.
Browser sign-in and public registration are unavailable in this mode. Sessions
use the existing workspace JWT issuance, storage and renewal paths.

For a previously anonymously created workspace, sign in and call
`POST /v1/workspaces/{slug}/claim` with both `Authorization: Bearer <session>`
and `X-Workspace-Token: <existing workspace token>`. This assigns ownership through
the normal permission checks. A login alone cannot claim someone else's workspace.

The owner can generate a pairing code with
`POST /v1/workspaces/{slug}/pairing-codes` using the session bearer, then enter it
in the desktop's Join workspace dialog. Codes are short-lived and single-use.
The paired computer appears in the workspace's devices; local accounts use the
same membership and device permissions as other accounts.

For a packaged development app, pass the same environment at launch (on macOS,
an operator can configure the app's `LSEnvironment`). Rebuilding/replacing the app
may replace that configuration. Do not enable this mode on the hosted service.

For a coordinated self-hosted build, `OPENAGENTS_CORE_SOURCE=bundled` pins both
the launcher's in-process core and agent daemon to the connector packaged inside
the app. It skips the startup npm core update and never falls back to a downloaded
core if that bundle is missing. Build with the intended connector source in the
launcher dependency directory; keep its original version and include a local build
manifest. This prevents a newer published connector without local backend features
from silently replacing the reviewed implementation. Unset the option to restore
normal newest-version selection.
