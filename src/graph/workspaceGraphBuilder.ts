import * as vscode from 'vscode';
import { GraphData } from './schema';
import { PythonRelationResolver } from './pythonRelationResolver';
import { PythonWorkspaceIndexer } from './pythonWorkspaceIndexer';
import { WorkspaceGraphCache } from './workspaceGraphCache';

export class PythonWorkspaceGraphBuilder {
  private readonly cache = new WorkspaceGraphCache();
  private readonly indexer = new PythonWorkspaceIndexer(this.cache);
  private readonly resolver = new PythonRelationResolver();

  public async buildGraph(workspaceFolder: vscode.WorkspaceFolder): Promise<GraphData> {
    const indexing = await this.indexer.indexWorkspace(workspaceFolder);
    const resolution = this.resolver.resolve(indexing.modules);

    return {
      nodes: resolution.nodes,
      edges: resolution.edges,
      meta: {
        workspaceName: workspaceFolder.name,
        generatedAt: new Date().toISOString(),
        fileCount: indexing.fileCount,
        engineVersion: '0.2.0-semantic-pipeline',
        diagnostics: {
          resolvedCalls: resolution.diagnostics.resolvedCalls,
          unresolvedCalls: resolution.diagnostics.unresolvedCalls,
          ambiguousCalls: resolution.diagnostics.ambiguousCalls,
          parserCacheHits: indexing.stats.cacheHits,
          parserCacheMisses: indexing.stats.cacheMisses
        },
        parseWarnings: indexing.stats.parseWarnings
      }
    };
  }
}
