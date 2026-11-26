# Installing a coordinated operation-approval build

Update the backend (migration 104), desktop Workspace frontend and agent connector
together. Back up the database, installed app and agent configuration first; stop
backend writers while taking the database dump and applying the migration.

For a local desktop build, populate the launcher's connector dependency with the
reviewed source before packaging. Preserve its package version and add a local
build manifest identifying the source revision. Set `OPENAGENTS_CORE_SOURCE=bundled`
in the app environment: both the in-process core and daemon will run only that
connector, without the startup npm update or fallback to unrelated global code.
Unset this option to restore normal newest-version selection. It is independent
of `OPENAGENTS_WORKSPACE_BUNDLE_FEED=off`.

For agents whose ordinary Codex entry point is an npm wrapper, configure
`CODEX_APPROVAL_BINARY` with an absolute native executable path. Controlled visitor
turns use this executable; owner turns retain their ordinary runtime. Include the
matching `codex-code-mode-host` helper beside the executable when shipped by that
release. Codex 0.172.0 with gpt-6-astra was verified in the installed application;
0.151.0 can exercise the protocol but is too old for that model. Never substitute
another model silently or relax the runtime's isolation checks.

After replacing the app, verify its signature and restart its daemon. Check the
startup log for the bundled-core selection and daemon CLI path. Verify installed
connector file hashes, database revision, localhost/LAN health and existing logins.
Use a disposable file inside the agent's working root for the live acceptance test:
visitor request → pending owner card → visitor cannot approve → owner takeover →
approve once while paused → unchanged file → resume → successful native rename.
Also reject a second request and confirm its file stays unchanged. Preserve
screenshots/status evidence, and remove only the disposable test files afterwards.

Distribute a matching client package to other devices without credentials or
server workspaces. They must install it locally; upgrading the server cannot
replace an already-installed client on a different computer.
