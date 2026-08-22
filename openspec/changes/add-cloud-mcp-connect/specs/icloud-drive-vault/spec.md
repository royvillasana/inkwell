## ADDED Requirements

### Requirement: iCloud Drive as a vault location

On macOS, Inkju SHALL detect `~/Library/Mobile Documents/com~apple~CloudDocs/` and allow the user to open a vault inside it. Inkju SHALL describe this as a folder that syncs through iCloud and SHALL NOT present it as an MCP connection or as an iCloud account sign-in.

#### Scenario: iCloud Drive is present
- **WHEN** the user opens the Connections surface on macOS with iCloud Drive enabled on the system
- **THEN** an iCloud Drive entry is offered that opens a vault inside the iCloud Drive folder

#### Scenario: iCloud Drive is absent
- **WHEN** the app runs on Windows or Linux, or the iCloud Drive folder does not exist
- **THEN** no iCloud Drive entry is shown and no error is raised

#### Scenario: Wording is accurate
- **WHEN** the iCloud Drive entry is displayed
- **THEN** its description states that the folder syncs through iCloud and makes no claim of an account connection, an API, or MCP

### Requirement: Dataless placeholder handling

Inkju SHALL detect files whose contents are not present locally before reading them, and SHALL NOT trigger materialization during background work.

#### Scenario: Background indexing does not download
- **WHEN** Inkju walks the vault tree or builds its search index over an iCloud vault containing evicted files
- **THEN** no evicted file is materialized, and evicted files are recorded as present but not locally available

#### Scenario: Opening an evicted file
- **WHEN** the user opens a note whose contents are not present locally
- **THEN** Inkju requests materialization, shows a downloading indicator instead of appearing frozen, and opens the note when the contents arrive

#### Scenario: Materialization fails
- **WHEN** materialization does not complete — the network is unavailable or iCloud declines
- **THEN** Inkju reports that the file could not be downloaded from iCloud and leaves the tab unopened rather than showing empty content

### Requirement: `.icloud` stub files

Inkju SHALL recognise `.<name>.icloud` placeholder files, resolve them to the note they represent, and SHALL NOT display them as separate notes.

#### Scenario: Stub in the sidebar
- **WHEN** the vault tree contains `.Journal.md.icloud`
- **THEN** the sidebar shows a single entry named `Journal.md` marked as not downloaded, and no entry named `.Journal.md.icloud`

### Requirement: iCloud conflict files

Inkju SHALL detect iCloud's conflicted-copy siblings and surface them as conflicts rather than as ordinary notes.

#### Scenario: A conflicted copy appears
- **WHEN** iCloud writes a conflicted copy of a note into the vault
- **THEN** the sidebar marks that note as conflicted and offers to open both versions for comparison

#### Scenario: Conflicts are not silently resolved
- **WHEN** a note has a conflicted copy
- **THEN** Inkju does not merge, delete, or overwrite either version on its own

### Requirement: Writes remain atomic inside an iCloud vault

Inkju's atomic write — write to a sibling temporary file, then rename — SHALL remain safe inside an iCloud vault, and SHALL NOT leave temporary files visible to iCloud sync.

#### Scenario: Saving a note in an iCloud vault
- **WHEN** the user saves a note stored inside the iCloud Drive folder
- **THEN** the write completes atomically, the finished note is the only file remaining, and no `.tmp` artefact is left behind for iCloud to sync

#### Scenario: Interrupted write
- **WHEN** the app is terminated part-way through writing a note in an iCloud vault
- **THEN** the previous version of the note remains intact and is not truncated

### Requirement: Eviction of an open note

Inkju SHALL tolerate a note being evicted by macOS while it is open in a tab.

#### Scenario: Open note is evicted
- **WHEN** macOS evicts a note that is currently open in a tab
- **THEN** the tab remains readable from its in-memory copy, and the next save re-materializes the file before writing rather than failing
