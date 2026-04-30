# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]

## [0.2.0] - 2026-04-26

### Added
- Variable assignment indexing via Lezer AST (`AssignStatement` extraction).
- Data-flow edge resolution linking function return values to assigned variables.
- New graph schema types: `variable` node type, `dataflow` and `execution-path` edge types.
- Module-level call reference support (calls outside functions are now captured).

### Changed
- Webview filters out variable nodes for visual clarity while retaining them in the graph model.
- Edge selection logic reworked: prefers call/dependency edges, falls back to non-containment edges.
- Hardened VS Code Marketplace metadata and prepublish validation.
- Updated packaging and release documentation.
- Refined git and VSIX ignore patterns for generated artifacts.

## [0.1.1] - 2026-04-17

### Changed
- Republished FlowDE with the rogue-socket publisher and refreshed packaging toolchain.

## [0.1.0] - 2026-04-07

### Added
- Initial release of FlowDE.
- Graph-native Python code comprehension panel.
- Semantic indexing and relation resolution for Python workspaces.
- Interactive webview graph rendering and node-to-code navigation.
