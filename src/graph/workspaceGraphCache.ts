import { IndexedModule } from './semanticTypes';

/**
 * Cached parser output keyed by file path and content version.
 */
interface CacheEntry {
  version: string;
  module: IndexedModule;
}

/**
 * In-memory workspace cache to avoid reparsing unchanged Python modules.
 */
export class WorkspaceGraphCache {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Retrieves a cached module only when the requested version matches exactly.
   */
  public get(relativePath: string, version: string): IndexedModule | undefined {
    const entry = this.entries.get(relativePath);
    if (!entry || entry.version !== version) {
      return undefined;
    }

    return entry.module;
  }

  /**
   * Stores module parse output for a file version.
   */
  public set(relativePath: string, version: string, module: IndexedModule): void {
    this.entries.set(relativePath, { version, module });
  }

  /**
   * Evicts cache entries for files that no longer exist in the workspace scan.
   */
  public sweep(validRelativePaths: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (!validRelativePaths.has(key)) {
        this.entries.delete(key);
      }
    }
  }
}
