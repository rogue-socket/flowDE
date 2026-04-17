import * as vscode from 'vscode';
import { GraphData, GraphLayer } from './schema';
import { PythonRelationResolver } from './pythonRelationResolver';
import { PythonWorkspaceIndexer } from './pythonWorkspaceIndexer';
import { WorkspaceGraphCache } from './workspaceGraphCache';

/**
 * Builds the complete workspace graph by combining indexing and relationship resolution.
 */
export class PythonWorkspaceGraphBuilder {
  private readonly cache = new WorkspaceGraphCache();
  private readonly indexer = new PythonWorkspaceIndexer(this.cache);
  private readonly resolver = new PythonRelationResolver();

  /**
   * Produces graph nodes, edges, and diagnostics for a workspace folder.
   */
  public async buildGraph(workspaceFolder: vscode.WorkspaceFolder): Promise<GraphData> {
    const indexing = await this.indexer.indexWorkspace(workspaceFolder);
    const resolution = this.resolver.resolve(indexing.modules);
    const layerStats = this.computeLayerStats(resolution.nodes, resolution.edges);

    return {
      nodes: resolution.nodes,
      edges: resolution.edges,
      meta: {
        workspaceName: workspaceFolder.name,
        generatedAt: new Date().toISOString(),
        fileCount: indexing.fileCount,
        engineVersion: '0.3.0-graph-layers',
        layerStats,
        diagnostics: {
          resolvedCalls: resolution.diagnostics.resolvedCalls,
          unresolvedCalls: resolution.diagnostics.unresolvedCalls,
          ambiguousCalls: resolution.diagnostics.ambiguousCalls,
          classUsageEdges: resolution.diagnostics.classUsageEdges,
          indexedClasses: resolution.diagnostics.indexedClasses,
          parserCacheHits: indexing.stats.cacheHits,
          parserCacheMisses: indexing.stats.cacheMisses
        },
        parseWarnings: indexing.stats.parseWarnings
      }
    };
  }

  /**
   * Computes per-layer node and edge counts used by the webview layer controls.
   */
  private computeLayerStats(
    nodes: GraphData['nodes'],
    edges: GraphData['edges']
  ): Record<GraphLayer, GraphData['meta']['layerStats'][GraphLayer]> {
    const result: Record<GraphLayer, GraphData['meta']['layerStats'][GraphLayer]> = {
      structural: { nodes: 0, edges: 0, visibleByDefault: true },
      dependency: { nodes: 0, edges: 0, visibleByDefault: true }
    };

    for (const node of nodes) {
      for (const layer of node.layers) {
        result[layer].nodes += 1;
      }
    }

    for (const edge of edges) {
      result[edge.layer].edges += 1;
    }

    return result;
  }
}
