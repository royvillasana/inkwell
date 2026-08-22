## ADDED Requirements

### Requirement: Browsing a connection's files

For a connection that exposes file listing or search tools, Inkju SHALL provide a browser panel that lists and searches that connection's files without downloading their contents.

#### Scenario: Listing files
- **WHEN** the user opens the browser panel for a connected source
- **THEN** Inkju calls the connection's listing tool and displays the results with name, modified time and size, having transferred no file bodies

#### Scenario: Searching
- **WHEN** the user types a query in the browser panel
- **THEN** Inkju calls the connection's search tool and displays matching files

#### Scenario: Connection is not connected
- **WHEN** the user opens the browser panel for a connection that is disconnected or failed
- **THEN** the panel shows the connection's status and offers to connect, rather than showing an empty list

### Requirement: Opening a remote document

Inkju SHALL open a remote markdown file in a normal editor tab. A remote tab SHALL record its connection id, remote identifier, version marker and writability instead of a local filesystem path.

#### Scenario: Opening a markdown file
- **WHEN** the user opens a markdown file from a connection
- **THEN** Inkju fetches its content, opens it in a tab with all normal editing features available, and the tab displays which connection it came from

#### Scenario: Opening a non-text file
- **WHEN** the user opens a file that is not text or markdown
- **THEN** Inkju does not open it in the editor and instead offers to save a copy into the vault

#### Scenario: File exceeds the remote size limit
- **WHEN** a remote file is larger than the remote size limit
- **THEN** Inkju refuses to open it in the editor, states the limit, and offers to save a copy into the vault

### Requirement: Saving a remote document

Inkju SHALL save a remote document back through the connection's write tool only when that tool is allowed. Autosave SHALL be disabled for remote documents by default.

#### Scenario: Saving to a writable connection
- **WHEN** the user presses the save shortcut in a remote tab on a writable connection and confirms the write
- **THEN** Inkju calls the connection's write tool, updates the tab's version marker from the response, and marks the tab clean

#### Scenario: Read-only connection
- **WHEN** the user presses the save shortcut in a remote tab whose connection has no allowed write tool
- **THEN** Inkju does not attempt a write and instead offers to save a copy into the vault

#### Scenario: Autosave does not fire for remote tabs
- **WHEN** the user edits a remote document and stops typing past the autosave delay
- **THEN** no write is sent to the connection, and the tab shows unsaved changes

#### Scenario: Saving while offline
- **WHEN** the user saves a remote document and the connection is unavailable
- **THEN** the write fails with a clear message, the tab keeps its unsaved changes, and no content is lost

### Requirement: Conflict detection on remote writes

Before writing a remote document, Inkju SHALL re-read the remote version marker and compare it with the marker recorded when the document was opened or last saved. Inkju SHALL NOT overwrite a remote file whose version marker has changed without the user's explicit choice.

#### Scenario: Remote file changed since opening
- **WHEN** the remote version marker differs from the recorded marker at save time
- **THEN** Inkju halts the write and offers three choices: overwrite with the local version, discard local changes and reload the remote version, or save a copy into the vault

#### Scenario: Version marker unavailable
- **WHEN** a connection provides no version marker for a file
- **THEN** Inkju treats every save as potentially conflicting and requires confirmation each time

### Requirement: Importing into the vault

Inkju SHALL allow copying a remote file into the currently open vault as an ordinary local file.

#### Scenario: Importing a file
- **WHEN** the user chooses to save a remote file into the vault
- **THEN** Inkju writes it through the existing atomic write path, inside the vault root, with a non-colliding filename, and the file thereafter behaves as any local note

#### Scenario: Import respects the path guard
- **WHEN** a remote file's name would resolve outside the vault root
- **THEN** the name is sanitised to a plain filename within the chosen folder and the write never escapes the vault root

### Requirement: Vault-only features stay vault-only

Version history, backlinks, wiki-link resolution, and the vault-wide search index SHALL continue to operate over local vault files only and SHALL NOT be extended across remote sources by this change.

#### Scenario: Version history in a remote tab
- **WHEN** the user opens version history in a remote tab
- **THEN** Inkju states that version history covers vault files only, rather than showing an empty or misleading history

#### Scenario: Wiki link in a remote document
- **WHEN** a remote document contains a wiki link
- **THEN** the link is resolved against the open vault, and an unresolved link is displayed as unresolved rather than searched for across the connection
