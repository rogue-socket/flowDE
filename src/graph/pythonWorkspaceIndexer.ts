import * as vscode from 'vscode';
import { parser } from '@lezer/python';
import { SyntaxNode } from '@lezer/common';
import { GraphNode } from './schema';
import {
  ImportBinding,
  IndexedCallReference,
  IndexedFunctionSymbol,
  IndexedModule,
  IndexingResult
} from './semanticTypes';
import { WorkspaceGraphCache } from './workspaceGraphCache';

const PYTHON_EXCLUDE_GLOB = '**/{.git,node_modules,.venv,venv,__pycache__,dist}/**';

export class PythonWorkspaceIndexer {
  constructor(private readonly cache: WorkspaceGraphCache) {}

  public async indexWorkspace(workspaceFolder: vscode.WorkspaceFolder): Promise<IndexingResult> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.py'),
      PYTHON_EXCLUDE_GLOB
    );

    const modules: IndexedModule[] = [];
    const parseWarnings: string[] = [];
    const validRelativePaths = new Set<string>();
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const fileUri of files) {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false);
      validRelativePaths.add(relativePath);

      try {
        const stats = await vscode.workspace.fs.stat(fileUri);
        const version = `${stats.mtime}:${stats.size}`;
        const cachedModule = this.cache.get(relativePath, version);

        if (cachedModule) {
          cacheHits += 1;
          modules.push(cachedModule);
          if (cachedModule.warning) {
            parseWarnings.push(cachedModule.warning);
          }
          continue;
        }

        cacheMisses += 1;
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const source = Buffer.from(bytes).toString('utf8');
        const module = this.indexPythonFile(relativePath, source);
        this.cache.set(relativePath, version, module);

        modules.push(module);
        if (module.warning) {
          parseWarnings.push(module.warning);
        }
      } catch (error) {
        cacheMisses += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        parseWarnings.push(`Failed to parse ${relativePath}: ${errorMessage}`);
        modules.push(this.createFallbackModule(relativePath));
      }
    }

    this.cache.sweep(validRelativePaths);

    return {
      modules,
      fileCount: files.length,
      stats: {
        parseWarnings,
        cacheHits,
        cacheMisses
      }
    };
  }

  private indexPythonFile(relativePath: string, source: string): IndexedModule {
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
    const parseArtifacts = this.collectFunctionsAndCalls(source, relativePath, moduleNodeId, moduleName);

    return {
      relativePath,
      moduleName,
      moduleNode,
      functions: parseArtifacts.functions,
      callRefs: parseArtifacts.callRefs,
      dependencies: importArtifacts.dependencies,
      importBindings: importArtifacts.importBindings,
      warning: parseArtifacts.warning
    };
  }

  private createFallbackModule(relativePath: string): IndexedModule {
    const moduleName = this.moduleNameFromPath(relativePath);
    return {
      relativePath,
      moduleName,
      moduleNode: {
        id: `module:${relativePath}`,
        type: 'module',
        name: moduleName,
        filePath: relativePath,
        line: 1
      },
      functions: [],
      callRefs: [],
      dependencies: [],
      importBindings: []
    };
  }

  private collectFunctionsAndCalls(
    source: string,
    relativePath: string,
    moduleNodeId: string,
    moduleName: string
  ): { functions: IndexedFunctionSymbol[]; callRefs: IndexedCallReference[]; warning?: string } {
    const functions: IndexedFunctionSymbol[] = [];
    const callRefs: IndexedCallReference[] = [];

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
