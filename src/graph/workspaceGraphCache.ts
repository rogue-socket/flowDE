import { IndexedModule } from './semanticTypes';

interface CacheEntry {
  version: string;
  module: IndexedModule;
}

export class WorkspaceGraphCache {
  private readonly entries = new Map<string, CacheEntry>();

  public get(relativePath: string, version: string): IndexedModule | undefined {
    const entry = this.entries.get(relativePath);
    if (!entry || entry.version !== version) {
      return undefined;
    }

    return entry.module;
  }

  public set(relativePath: string, version: string, module: IndexedModule): void {
    this.entries.set(relativePath, { version, module });
  }

  public sweep(validRelativePaths: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (!validRelativePaths.has(key)) {
        this.entries.delete(key);
      }
    }
  }
}
