import * as vscode from 'vscode';
import { parser } from '@lezer/python';
import { SyntaxNode } from '@lezer/common';
import { GraphData, GraphEdge, GraphNode } from './schema';

const PYTHON_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,dist}/**';

interface FunctionSymbol {
  id: string;
  name: string;
  filePath: string;
  line: number;
  moduleNodeId: string;
  moduleName: string;
}

interface CallReference {
  sourceFunctionId: string;
  sourceModuleId: string;
  sourceModuleName: string;
  calleeName: string;
  calleePath: string[];
}

interface ImportBinding {
  alias: string;
  kind: 'module' | 'symbol';
  moduleName: string;
  symbolName?: string;
}

interface FileParseResult {
  moduleNode: GraphNode;
  functions: FunctionSymbol[];
  callRefs: CallReference[];
  dependencies: string[];
  importBindings: ImportBinding[];
  warning?: string;
}

export class PythonWorkspaceGraphBuilder {
  public async buildGraph(workspaceFolder: vscode.WorkspaceFolder): Promise<GraphData> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.py'),
      PYTHON_EXCLUDE_GLOB
    );

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const parseWarnings: string[] = [];
    const functionSymbols: FunctionSymbol[] = [];
    const callRefs: CallReference[] = [];
    const dependencyRecords: Array<{ sourceModuleId: string; dependency: string }> = [];
    const moduleNameToNodeId = new Map<string, string>();
    const externalModuleNodes = new Map<string, GraphNode>();
    const importBindingsByModuleId = new Map<string, ImportBinding[]>();
    const dependenciesByModuleId = new Map<string, Set<string>>();

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);

      try {
        const content = await vscode.workspace.fs.readFile(fileUri);
        const source = Buffer.from(content).toString('utf8');
        const fileResult = this.parsePythonFile(relativePath, source);

        nodes.push(fileResult.moduleNode);
        moduleNameToNodeId.set(fileResult.moduleNode.name, fileResult.moduleNode.id);
        importBindingsByModuleId.set(fileResult.moduleNode.id, fileResult.importBindings);
        dependenciesByModuleId.set(fileResult.moduleNode.id, new Set(fileResult.dependencies));
        functionSymbols.push(...fileResult.functions);
        callRefs.push(...fileResult.callRefs);

        for (const dependency of fileResult.dependencies) {
          dependencyRecords.push({
            sourceModuleId: fileResult.moduleNode.id,
            dependency
          });
        }

        if (fileResult.warning) {
          parseWarnings.push(fileResult.warning);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        parseWarnings.push(`Failed to parse ${relativePath}: ${errorMessage}`);
      }
    }

    nodes.push(
      ...functionSymbols.map((symbol) => ({
        id: symbol.id,
        type: 'function' as const,
        name: symbol.name,
        filePath: symbol.filePath,
        line: symbol.line,
        metadata: {
          moduleNodeId: symbol.moduleNodeId
        }
      }))
    );

    const functionSymbolsByName = new Map<string, FunctionSymbol[]>();
    const functionSymbolsByModuleAndName = new Map<string, FunctionSymbol[]>();

    for (const symbol of functionSymbols) {
      const list = functionSymbolsByName.get(symbol.name) ?? [];
      list.push(symbol);
      functionSymbolsByName.set(symbol.name, list);

      const scopedKey = this.functionScopeKey(symbol.moduleName, symbol.name);
      const scopedList = functionSymbolsByModuleAndName.get(scopedKey) ?? [];
      scopedList.push(symbol);
      functionSymbolsByModuleAndName.set(scopedKey, scopedList);
    }

    const uniqueEdgeIds = new Set<string>();

    for (const symbol of functionSymbols) {
      const containsEdgeId = `edge:contains:${symbol.moduleNodeId}->${symbol.id}`;
      if (uniqueEdgeIds.has(containsEdgeId)) {
        continue;
      }

      uniqueEdgeIds.add(containsEdgeId);
      edges.push({
        id: containsEdgeId,
        source: symbol.moduleNodeId,
        target: symbol.id,
        type: 'contains'
      });
    }

    for (const callRef of callRefs) {
      const targetFunctionId = this.resolveCallTarget(
        callRef,
        functionSymbolsByName,
        functionSymbolsByModuleAndName,
        importBindingsByModuleId,
        dependenciesByModuleId
      );
      if (!targetFunctionId) {
        continue;
      }

      const edgeId = `edge:call:${callRef.sourceFunctionId}->${targetFunctionId}`;
      if (uniqueEdgeIds.has(edgeId)) {
        continue;
      }

      uniqueEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        source: callRef.sourceFunctionId,
        target: targetFunctionId,
        type: 'call'
      });
    }

    for (const record of dependencyRecords) {
      const moduleName = record.dependency;
      let targetModuleId = moduleNameToNodeId.get(moduleName);

      if (!targetModuleId) {
        const externalId = `module:external:${moduleName}`;
        targetModuleId = externalId;

        if (!externalModuleNodes.has(moduleName)) {
          const externalNode: GraphNode = {
            id: externalId,
            type: 'module',
            name: moduleName,
            metadata: { external: true }
          };
          externalModuleNodes.set(moduleName, externalNode);
        }
      }

      const edgeId = `edge:dependency:${record.sourceModuleId}->${targetModuleId}`;
      if (uniqueEdgeIds.has(edgeId)) {
        continue;
      }

      uniqueEdgeIds.add(edgeId);
      edges.push({
        id: edgeId,
        source: record.sourceModuleId,
        target: targetModuleId,
        type: 'dependency'
      });
    }

    nodes.push(...externalModuleNodes.values());

    return {
      nodes,
      edges,
      meta: {
        workspaceName: workspaceFolder.name,
        generatedAt: new Date().toISOString(),
        fileCount: files.length,
        parseWarnings
      }
    };
  }

  private parsePythonFile(relativePath: string, source: string): FileParseResult {
    const moduleName = this.moduleNameFromPath(relativePath);
    const moduleNodeId = `module:${relativePath}`;
    const moduleNode: GraphNode = {
      id: moduleNodeId,
      type: 'module',
      name: moduleName,
      filePath: relativePath,
      line: 1
    };

    const importArtifacts = this.extractImportArtifacts(source, moduleName, relativePath);
    const parseArtifacts = this.collectFunctionsAndCalls(
      source,
      relativePath,
      moduleNodeId,
      moduleName
    );

    return {
      moduleNode,
      functions: parseArtifacts.functions,
      callRefs: parseArtifacts.callRefs,
      dependencies: importArtifacts.dependencies,
      importBindings: importArtifacts.importBindings,
      warning: parseArtifacts.warning
    };
  }

  private collectFunctionsAndCalls(
    source: string,
    relativePath: string,
    moduleNodeId: string,
    moduleName: string
  ): { functions: FunctionSymbol[]; callRefs: CallReference[]; warning?: string } {
    const functions: FunctionSymbol[] = [];
    const callRefs: CallReference[] = [];

    try {
      const tree = parser.parse(source);
      const lineMap = this.buildLineStartMap(source);

      const walk = (node: SyntaxNode, activeFunctionId?: string): void => {
        let currentFunctionId = activeFunctionId;

        if (node.type.name === 'FunctionDefinition') {
          const nameNode = this.findFirstChildByType(node, 'VariableName');
          if (nameNode) {
            const functionName = source.slice(nameNode.from, nameNode.to);
            const line = this.positionToLine(lineMap, nameNode.from);
            const functionId = `function:${relativePath}:${functionName}:${line}`;

            functions.push({
              id: functionId,
              name: functionName,
              filePath: relativePath,
              line,
              moduleNodeId,
              moduleName
            });

            currentFunctionId = functionId;
          }
        }

        if (node.type.name === 'CallExpression' && currentFunctionId) {
          const calleePath = this.extractCalleePath(node, source);
          if (calleePath && calleePath.length > 0) {
            callRefs.push({
              sourceFunctionId: currentFunctionId,
              sourceModuleId: moduleNodeId,
              sourceModuleName: moduleName,
              calleeName: calleePath[calleePath.length - 1],
              calleePath
            });
          }
        }

        for (let child = node.firstChild; child; child = child.nextSibling) {
          walk(child, currentFunctionId);
        }
      };

      walk(tree.topNode);

      return { functions, callRefs };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        functions,
        callRefs,
        warning: `Parser fallback on ${relativePath}: ${errorMessage}`
      };
    }
  }

  private resolveCallTarget(
    callRef: CallReference,
    functionSymbolsByName: Map<string, FunctionSymbol[]>,
    functionSymbolsByModuleAndName: Map<string, FunctionSymbol[]>,
    importBindingsByModuleId: Map<string, ImportBinding[]>,
    dependenciesByModuleId: Map<string, Set<string>>
  ): string | undefined {
    const candidates = functionSymbolsByName.get(callRef.calleeName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }

    const importBindings = importBindingsByModuleId.get(callRef.sourceModuleId) ?? [];
    const dependencies = dependenciesByModuleId.get(callRef.sourceModuleId) ?? new Set<string>();

    if (callRef.calleePath.length > 1) {
      const rootSymbol = callRef.calleePath[0];
      const qualifierPath = callRef.calleePath.slice(1, -1);
      const importedModules = importBindings.filter(
        (binding) => binding.kind === 'module' && binding.alias === rootSymbol
      );

      for (const binding of importedModules) {
        const targetModuleName =
          qualifierPath.length > 0
            ? `${binding.moduleName}.${qualifierPath.join('.')}`
            : binding.moduleName;

        const scopedCandidates = this.lookupScopedCandidates(
          functionSymbolsByModuleAndName,
          targetModuleName,
          callRef.calleeName
        );

        if (scopedCandidates.length === 1) {
          return scopedCandidates[0].id;
        }

        const dependencyScopedCandidates = scopedCandidates.filter((candidate) =>
          dependencies.has(candidate.moduleName)
        );

        if (dependencyScopedCandidates.length === 1) {
          return dependencyScopedCandidates[0].id;
        }
      }
    }

    if (callRef.calleePath.length === 1) {
      const importedSymbols = importBindings.filter(
        (binding) => binding.kind === 'symbol' && binding.alias === callRef.calleeName
      );

      const importedSymbolMatches = new Map<string, FunctionSymbol>();
      for (const binding of importedSymbols) {
        if (!binding.symbolName) {
          continue;
        }

        const scopedCandidates = this.lookupScopedCandidates(
          functionSymbolsByModuleAndName,
          binding.moduleName,
          binding.symbolName
        );

        for (const candidate of scopedCandidates) {
          importedSymbolMatches.set(candidate.id, candidate);
        }
      }

      if (importedSymbolMatches.size === 1) {
        return [...importedSymbolMatches.values()][0].id;
      }
    }

    const sameModuleCandidates = candidates.filter(
      (candidate) => candidate.moduleName === callRef.sourceModuleName
    );

    if (sameModuleCandidates.length === 1) {
      return sameModuleCandidates[0].id;
    }

    const dependencyScopedCandidates = candidates.filter((candidate) =>
      dependencies.has(candidate.moduleName)
    );

    if (dependencyScopedCandidates.length === 1) {
      return dependencyScopedCandidates[0].id;
    }

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    return undefined;
  }

  private extractImportArtifacts(
    source: string,
    moduleName: string,
    relativePath: string
  ): { dependencies: string[]; importBindings: ImportBinding[] } {
    const dependencies = new Set<string>();
    const importBindings: ImportBinding[] = [];

    for (const match of source.matchAll(/^\s*import\s+([^\n#]+)/gm)) {
      const importTargets = match[1].split(',');

      for (const target of importTargets) {
        const parsedTarget = this.parseAliasedTarget(target.trim());
        if (!parsedTarget) {
          continue;
        }

        dependencies.add(parsedTarget.name);
        importBindings.push({
          alias: parsedTarget.alias ?? parsedTarget.name.split('.')[0],
          kind: 'module',
          moduleName: parsedTarget.name
        });
      }
    }

    for (const match of source.matchAll(/^\s*from\s+([\.\w]+)\s+import\s+([^\n#]+)/gm)) {
      const importModule = this.resolveImportModule(match[1], moduleName, relativePath);
      if (!importModule) {
        continue;
      }

      dependencies.add(importModule);
      const importTargets = match[2].replace(/[()]/g, '').split(',');

      for (const target of importTargets) {
        const parsedTarget = this.parseAliasedTarget(target.trim());
        if (!parsedTarget || parsedTarget.name === '*') {
          continue;
        }

        importBindings.push({
          alias: parsedTarget.alias ?? parsedTarget.name,
          kind: 'symbol',
          moduleName: importModule,
          symbolName: parsedTarget.name
        });
      }
    }

    return {
      dependencies: [...dependencies],
      importBindings
    };
  }

  private moduleNameFromPath(relativePath: string): string {
    const withoutExtension = relativePath.replace(/\.py$/, '');
    const dotted = withoutExtension.replace(/\//g, '.');
    if (dotted.endsWith('.__init__')) {
      return dotted.slice(0, -'.__init__'.length);
    }
    return dotted;
  }

  private findFirstChildByType(node: SyntaxNode, typeName: string): SyntaxNode | undefined {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.type.name === typeName) {
        return child;
      }
    }

    return undefined;
  }

  private extractCalleePath(node: SyntaxNode, source: string): string[] | undefined {
    let calleeNode: SyntaxNode | undefined;

    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.type.name === 'ArgList') {
        break;
      }
      calleeNode = child;
    }

    if (!calleeNode) {
      return undefined;
    }

    const calleeText = source.slice(calleeNode.from, calleeNode.to);
    const parts = calleeText.match(/[A-Za-z_][A-Za-z0-9_]*/g);
    if (!parts || parts.length === 0) {
      return undefined;
    }

    return parts;
  }

  private parseAliasedTarget(target: string): { name: string; alias?: string } | undefined {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
      return undefined;
    }

    const parsed = normalizedTarget.match(/^([A-Za-z_][\w\.]*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/);
    if (!parsed) {
      return undefined;
    }

    return {
      name: parsed[1],
      alias: parsed[2]
    };
  }

  private resolveImportModule(
    rawImportModule: string,
    currentModuleName: string,
    relativePath: string
  ): string | undefined {
    if (!rawImportModule.startsWith('.')) {
      return rawImportModule;
    }

    const parsed = rawImportModule.match(/^(\.+)(.*)$/);
    if (!parsed) {
      return undefined;
    }

    const level = parsed[1].length;
    const remainder = parsed[2].trim();
    const currentPackageName = this.packageNameFromModule(currentModuleName, relativePath);
    const packageParts = currentPackageName ? currentPackageName.split('.') : [];
    const upwardLevels = level - 1;

    if (upwardLevels > packageParts.length) {
      return remainder || undefined;
    }

    const baseParts = packageParts.slice(0, packageParts.length - upwardLevels);
    const importParts = remainder ? remainder.split('.') : [];
    const resolvedParts = [...baseParts, ...importParts].filter((part) => part.length > 0);

    return resolvedParts.length > 0 ? resolvedParts.join('.') : undefined;
  }

  private packageNameFromModule(moduleName: string, relativePath: string): string {
    if (relativePath.endsWith('/__init__.py') || relativePath === '__init__.py') {
      return moduleName;
    }

    const lastDotIndex = moduleName.lastIndexOf('.');
    if (lastDotIndex < 0) {
      return '';
    }

    return moduleName.slice(0, lastDotIndex);
  }

  private functionScopeKey(moduleName: string, functionName: string): string {
    return `${moduleName}::${functionName}`;
  }

  private lookupScopedCandidates(
    functionSymbolsByModuleAndName: Map<string, FunctionSymbol[]>,
    moduleName: string,
    functionName: string
  ): FunctionSymbol[] {
    return functionSymbolsByModuleAndName.get(this.functionScopeKey(moduleName, functionName)) ?? [];
  }

  private buildLineStartMap(source: string): number[] {
    const lineStarts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 10) {
        lineStarts.push(index + 1);
      }
    }
    return lineStarts;
  }

  private positionToLine(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return Math.max(high + 1, 1);
  }
}
