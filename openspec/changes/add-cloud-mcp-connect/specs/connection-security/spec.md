## ADDED Requirements

### Requirement: Credentials never reach the renderer

No access token, refresh token, OAuth client secret, or secret environment value SHALL be exposed to the renderer process, the preload bridge's return values, or any log or error message shown in the UI.

#### Scenario: Renderer requests connection details
- **WHEN** the renderer asks the main process for a connection's details
- **THEN** it receives the id, label, transport kind, status and tool names only, with every credential field absent from the payload

#### Scenario: An authorization error is displayed
- **WHEN** an OAuth or tool call fails and the error is shown to the user
- **THEN** the message contains no token, code, verifier or client secret

### Requirement: Credentials at rest are encrypted by the operating system

Inkju SHALL encrypt stored credentials using Electron `safeStorage`, which delegates key management to Keychain, DPAPI or libsecret. Credentials SHALL be written to a file separate from `settings.json`. Inkju SHALL NOT write any credential in plaintext under any circumstance.

#### Scenario: Storing a credential
- **WHEN** Inkju persists a token or client secret
- **THEN** the value is encrypted through `safeStorage` and the ciphertext is written to the secrets file, not to `settings.json`

#### Scenario: OS encryption unavailable
- **WHEN** `safeStorage.isEncryptionAvailable()` returns false
- **THEN** Inkju keeps the credential in memory for the current session only, tells the user that the credential cannot be stored securely on this system and will need re-entering, and writes nothing to disk

#### Scenario: Decryption fails
- **WHEN** a stored credential cannot be decrypted, for example after an OS keychain change
- **THEN** the connection is marked as needing re-authorization and the unreadable credential is discarded

#### Scenario: Removing a connection clears its credentials
- **WHEN** a connection is removed
- **THEN** its stored credentials are deleted from the secrets file

### Requirement: Tools are deny-by-default

No tool on any connection SHALL be callable unless it is present in that connection's allowlist. Write-shaped tools SHALL be unticked when the allowlist is first proposed.

#### Scenario: Calling a tool that is not allowed
- **WHEN** any part of Inkju attempts to call a tool absent from the connection's allowlist
- **THEN** the call is refused before any request leaves the process

#### Scenario: Initial allowlist proposal
- **WHEN** the user is shown the allowlist for a newly connected server
- **THEN** read-shaped tools that Inkju needs to browse files are proposed pre-ticked, and every tool that creates, modifies, moves or deletes is unticked

#### Scenario: A newly advertised tool
- **WHEN** a server advertises a tool that was not in the allowlist
- **THEN** that tool is disabled and cannot be called until the user allows it

### Requirement: Destructive remote operations require confirmation

Every write, rename, move or delete against a remote source SHALL require an explicit confirmation naming the file and the connection, unless the user has enabled "don't ask again" for that specific connection. That setting SHALL default to off and SHALL be per-connection.

#### Scenario: Confirming a write
- **WHEN** Inkju is about to write a file through a connection and "don't ask again" is off for it
- **THEN** a dialog naming the file and the connection is shown, and nothing is sent until the user confirms

#### Scenario: Suppressing confirmation
- **WHEN** the user enables "don't ask again" for one connection
- **THEN** confirmations are suppressed for that connection only and remain in force for every other connection

#### Scenario: Deletions are never implicit
- **WHEN** any flow would delete a remote file
- **THEN** confirmation is required regardless of the "don't ask again" setting

### Requirement: Remote content is untrusted

Content received from a connection SHALL be treated as untrusted input. It SHALL NOT be executed, evaluated, passed to a shell, or passed to `shell.openExternal`. It SHALL be rendered through the same markdown pipeline as local content, under the existing renderer Content Security Policy, which SHALL NOT be relaxed by this change.

#### Scenario: Remote note contains a script
- **WHEN** a remote markdown file contains a script tag or an event-handler attribute
- **THEN** it is escaped and displayed as text, and nothing executes

#### Scenario: Size limit on remote responses
- **WHEN** a tool returns a response larger than the configured remote size limit
- **THEN** the operation fails with an explanatory message and the oversized payload is discarded rather than rendered

#### Scenario: Malformed tool response
- **WHEN** a tool response does not match its expected schema
- **THEN** the operation fails rather than coercing the value, and the connection remains usable for other operations

#### Scenario: No agent loop over remote content
- **WHEN** remote content is opened
- **THEN** Inkju does not pass it to a language model or execute any instruction it contains

### Requirement: Path safety for imported content

Any filename or path derived from a remote source SHALL be sanitised before it touches the filesystem and SHALL be subject to the existing vault path guard.

#### Scenario: Remote name contains traversal
- **WHEN** a remote file is named `../../.ssh/authorized_keys`
- **THEN** the name is reduced to a plain filename inside the chosen folder, and no write occurs outside the vault root

#### Scenario: Remote name collides with an existing note
- **WHEN** an imported file's name matches a note already in the target folder
- **THEN** a non-colliding name is chosen and the existing note is not overwritten

### Requirement: Network access is opt-in

Inkju SHALL make no outbound request on behalf of a connection unless the user has configured and enabled that connection.

#### Scenario: Fresh install
- **WHEN** Inkju runs with no connections configured
- **THEN** it makes no network request other than the existing update check and spawns no MCP child process

#### Scenario: Disabled connection
- **WHEN** a connection exists but is disabled
- **THEN** Inkju neither connects to it nor refreshes its tokens
