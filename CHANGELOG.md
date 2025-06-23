# Change Log

All notable changes to the "DMDB" extension will be documented in this file.

## [v1.0.0] - 2025-01-07

- Initial release

### Added

- Laravel parser from migrations
- Mermaid viewer
- Json viewer

### Known issues
- Many to Many relations are not supported and relations tables appear as empty tables.
- Diagrams with the relationships do not go all the way to the top.

## [v1.1.0] - 2025-03-16

### Added
- Symfony parser from entities
- Symfony framework now supported
- Setting to change the framework directory's path

### Fixed
- Mermaid viewer no longer duplicates tables
- Diagrams with the relationships now go all the way to the top

### Known issues
- No issues known at this time, feel free to report any!


## [v1.1.1] - 2025-06-23

### Added
- Json viewer now supports commited changes

### Fixed
- Mermaid viewer now correctly handles tables with no relationships
- Symfony parser now correctly handles fields with Timestamp type (e.g., `created_at`, `updated_at`)
- Increased font size in Mermaid viewer for better readability

### Known issues
- No issues known at this time, feel free to report any!