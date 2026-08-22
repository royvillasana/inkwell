## ADDED Requirements

### Requirement: Connection registry

Inkju SHALL maintain a list of user-configured connections. Each connection record SHALL carry a stable id, a user-editable label, a transport kind (`stdio`, `http`, or `local`), its transport configuration, an enabled flag, and the tool allowlist. Connection records SHALL be persisted in the application settings store; no credential SHALL be persisted in that store.

#### Scenario: No connections configured
- **WHEN** Inkju starts and the settings store contains no connections
- **THEN** the app behaves exactly as it does today, makes no outbound network request beyond the existing update check, and spawns no child process

#### Scenario: Adding a connection
- **WHEN** the user completes the add-connection flow with a valid configuration
- **THEN** a connection record is written to the settings store with a stable id, `enabled: true`, and an allowlist containing only the tools the user ticked

#### Scenario: Removing a connection
- **WHEN** the user removes a connection
- **THEN** the connection is disconnected, its child process (if any) is terminated, its stored credentials are deleted, and its record is removed from the settings store

#### Scenario: Renaming a connection
- **WHEN** the user edits a connection's label
- **THEN** the label changes everywhere it is displayed and the connection's id, credentials and allowlist are unaffected

### Requirement: Stdio transport

Inkju SHALL support connecting to a local MCP server over stdio by spawning a user-specified command with user-specified arguments and environment. Inkju SHALL NOT install, download, or fetch any package on the user's behalf without a confirmation that names the package.

#### Scenario: Connecting over stdio
- **WHEN** the user enables a stdio connection
- **THEN** Inkju spawns the configured command, completes the MCP initialize handshake, calls `tools/list`, and reports the connection as connected

#### Scenario: Command is shown before it runs
- **WHEN** the user is about to confirm a new stdio connection
- **THEN** the exact command, arguments and non-secret environment variables are displayed verbatim, and the connection is not created until the user confirms

#### Scenario: Command exits or fails to start
- **WHEN** the spawned process exits non-zero or cannot be started
- **THEN** the connection is reported as failed with the process's stderr shown to the user, and Inkju does not respawn it in a loop

#### Scenario: Stdio does not use OAuth
- **WHEN** a stdio connection is configured
- **THEN** no OAuth flow is offered or attempted, and credentials are supplied only as environment variables

### Requirement: Streamable HTTP transport

Inkju SHALL support connecting to a remote MCP server over Streamable HTTP. Inkju SHALL refuse `http://` URLs except for `127.0.0.1` and `localhost`.

#### Scenario: Connecting to an HTTPS server
- **WHEN** the user enables an HTTP connection whose URL uses HTTPS
- **THEN** Inkju connects, completes the handshake, lists tools, and reports the connection as connected

#### Scenario: Plaintext HTTP is refused
- **WHEN** the user enters an `http://` URL whose host is not `127.0.0.1` or `localhost`
- **THEN** the connection is rejected with a message explaining that HTTPS is required, and no request is made to that URL

### Requirement: OAuth authorization for HTTP connections

For HTTP connections that require authorization, Inkju SHALL implement the MCP authorization flow: discover the authorization server from OAuth 2.0 Protected Resource Metadata advertised in the `401` response, discover authorization server metadata via both RFC 8414 and OpenID Connect Discovery, use authorization code with PKCE, include the RFC 8707 `resource` parameter set to the server's canonical URI in both the authorization and token requests, and validate the `iss` parameter (RFC 9207) against the recorded issuer before transmitting the authorization code.

#### Scenario: Authorizing a connection
- **WHEN** connecting returns `401` with a `WWW-Authenticate` header naming a resource metadata URL
- **THEN** Inkju discovers the authorization server, generates PKCE parameters, opens the system browser at the authorization URL, and does not display or embed the authorization page inside the app

#### Scenario: Receiving the authorization code
- **WHEN** the authorization server redirects to Inkju's loopback callback with a code
- **THEN** Inkju verifies the `state` value, validates `iss` against the recorded issuer, exchanges the code and verifier for tokens, stores them, and reconnects on a fresh transport instance

#### Scenario: Issuer mismatch
- **WHEN** the authorization response carries an `iss` value that does not match the recorded issuer under simple string comparison
- **THEN** Inkju rejects the response, does not send the code to any token endpoint, does not display the response's `error_description`, and reports an authorization failure

#### Scenario: Loopback listener lifetime
- **WHEN** an authorization flow starts
- **THEN** an HTTP listener bound only to `127.0.0.1` on an ephemeral port is started for that flow, and it is torn down when the flow completes, fails, or is cancelled

#### Scenario: Scope selection
- **WHEN** the `401` challenge carries a `scope` parameter
- **THEN** Inkju requests exactly those scopes; and when it does not, Inkju requests `scopes_supported` from the protected resource metadata, omitting `scope` if that field is absent

#### Scenario: Step-up on insufficient scope
- **WHEN** a tool call returns `403` with `error="insufficient_scope"`
- **THEN** Inkju re-authorizes requesting the union of the previously requested scopes and the challenged scopes, retries the operation at most three times, and then reports a permanent authorization failure

#### Scenario: Token refresh
- **WHEN** a stored access token has expired and a refresh token is available
- **THEN** Inkju refreshes it without user interaction; and when refresh fails, the connection is marked as needing re-authorization and the user is prompted rather than the operation failing silently

### Requirement: Connection status and health

Every connection SHALL report exactly one status: `disconnected`, `connecting`, `connected`, `needs-authorization`, or `failed`. Status changes SHALL be pushed to the renderer.

#### Scenario: Server becomes unreachable mid-session
- **WHEN** a connected server stops responding
- **THEN** the connection moves to `failed`, open documents from that connection remain readable from their in-memory copies, and the user is told the connection is unavailable rather than being shown an unexplained error

#### Scenario: Reconnecting after failure
- **WHEN** the user retries a failed connection
- **THEN** Inkju attempts a fresh connection and reports the result; Inkju does not retry automatically in a tight loop

### Requirement: Tool discovery

On connecting, Inkju SHALL call `tools/list` and record the server's advertised tools. Inkju SHALL display the tool names and descriptions to the user.

#### Scenario: Tool list changes between sessions
- **WHEN** a server advertises a tool that was not present when the connection was last used
- **THEN** the new tool is recorded as disabled, and the user is notified that the connection's capabilities changed

#### Scenario: A required tool disappears
- **WHEN** a connection no longer advertises a tool Inkju needs to browse files
- **THEN** the affected feature is disabled for that connection with an explanation, and the rest of the connection continues to work

### Requirement: Google Drive preset

Inkju SHALL ship a Google Drive connection preset as declarative configuration data rather than code, so that its URL, scopes and tool names can change without an application release.

#### Scenario: Using the preset
- **WHEN** the user chooses the Google Drive preset
- **THEN** the server URL and scopes are pre-filled, the user is prompted for their own OAuth client ID and secret with a link to the Google Cloud console, and the OAuth flow proceeds as for any HTTP connection

#### Scenario: Missing OAuth client credentials
- **WHEN** the user attempts to connect the Drive preset without supplying a client ID
- **THEN** the connection is not attempted and the user is shown what is missing and where to obtain it
