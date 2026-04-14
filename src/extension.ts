import * as vscode from 'vscode';
import { PythonWorkspaceGraphBuilder } from './graph/workspaceGraphBuilder';
import { GraphData, GraphNode } from './graph/schema';

/**
 * Messages received from the webview front-end.
 */
type IncomingWebviewMessage =
  | { type: 'ready' }
  | { type: 'refreshGraph' }
  | { type: 'navigateToNode'; nodeId: string };

/**
 * Extension activation entrypoint.
 */
export function activate(context: vscode.ExtensionContext): void {
  const graphBuilder = new PythonWorkspaceGraphBuilder();
  let flowPanel: FlowDEPanel | undefined;

  const openGraphCommand = vscode.commands.registerCommand('flowde.openGraphView', async () => {
    const workspaceFolder = resolveWorkspaceFolder();

    if (!workspaceFolder) {
      vscode.window.showWarningMessage('FlowDE needs an open workspace folder to build a graph.');
      return;
    }

    if (flowPanel) {
      flowPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel('flowde.graph', 'FlowDE Graph', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });

    flowPanel = new FlowDEPanel(panel, context.extensionUri, workspaceFolder, graphBuilder, () => {
      flowPanel = undefined;
    });

    context.subscriptions.push(flowPanel);
  });

  context.subscriptions.push(openGraphCommand);
}

/**
 * Extension deactivation hook.
 */
export function deactivate(): void {
  // No-op.
}

/**
 * Owns a single FlowDE webview panel and bridges graph operations.
 */
class FlowDEPanel implements vscode.Disposable {
  private readonly nodeById = new Map<string, GraphNode>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watcher: vscode.FileSystemWatcher;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshInFlight = false;
  private refreshQueued = false;
  private disposed = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly graphBuilder: PythonWorkspaceGraphBuilder,
    private readonly onDispose: () => void
  ) {
    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);

    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspaceFolder, '**/*.py')
    );

    this.disposables.push(this.watcher);
    this.watcher.onDidCreate(() => this.scheduleRefresh(), this, this.disposables);
    this.watcher.onDidChange(() => this.scheduleRefresh(), this, this.disposables);
    this.watcher.onDidDelete(() => this.scheduleRefresh(), this, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: IncomingWebviewMessage) => this.handleMessage(message),
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /**
   * Brings the panel to the foreground if it already exists.
   */
  public reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /**
   * Cleans up panel resources.
   */
  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.onDispose();

    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  /**
   * Routes incoming webview messages to host-side handlers.
   */
  private handleMessage(message: IncomingWebviewMessage): void {
    switch (message.type) {
      case 'ready':
      case 'refreshGraph': {
        void this.refreshGraph();
        break;
      }
      case 'navigateToNode': {
        void this.navigateToNode(message.nodeId);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Debounces graph refresh operations when workspace files change.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      void this.refreshGraph();
    }, 250);
  }

  /**
   * Rebuilds graph data and posts it to the webview.
   */
  private async refreshGraph(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;

    try {
      const graphData = await this.graphBuilder.buildGraph(this.workspaceFolder);
      this.nodeById.clear();

      for (const node of graphData.nodes) {
        this.nodeById.set(node.id, node);
      }

      await this.postGraphData(graphData);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.panel.webview.postMessage({ type: 'graphError', message });
    } finally {
      this.refreshInFlight = false;

      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshGraph();
      }
    }
  }

  /**
   * Opens and reveals source for a graph node in the editor.
   */
  private async navigateToNode(nodeId: string): Promise<void> {
    const node = this.nodeById.get(nodeId);
    if (!node || !node.filePath || typeof node.line !== 'number') {
      return;
    }

    const targetUri = vscode.Uri.joinPath(this.workspaceFolder.uri, node.filePath);
    const document = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: false,
      viewColumn: vscode.ViewColumn.One
    });

    const lineNumber = Math.max(node.line - 1, 0);
    const position = new vscode.Position(lineNumber, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * Sends graph data to the webview.
   */
  private async postGraphData(graphData: GraphData): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'graphData',
      payload: graphData
    });
  }

  /**
   * Builds the HTML scaffold for the FlowDE webview panel.
   */
  private getWebviewHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'styles.css'));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <link rel="stylesheet" href="${styleUri}" />
    <title>FlowDE Graph</title>
  </head>
  <body>
    <div class="shell">
      <header class="toolbar">
        <div class="title-group">
          <h1>FlowDE</h1>
          <p>Simple flowchart editor</p>
        </div>
        <div class="toolbar-actions">
          <button id="layout-btn" type="button">Layout: Top to Bottom</button>
          <button id="fit-btn" type="button">Fit</button>
          <button id="refresh-btn" type="button">Refresh</button>
        </div>
      </header>
      <section class="status-row">
        <span id="status">Loading graph...</span>
      </section>
      <main class="workspace-layout">
        <aside class="flow-sidebar" aria-label="Flow sidebar">
          <div class="sidebar-section">
            <h2>Flow Controls</h2>
            <label class="field">
              <span>Max depth</span>
              <div class="range-row">
                <input id="max-depth" type="range" min="2" max="14" step="1" value="8" />
                <span id="max-depth-value">8</span>
              </div>
            </label>
            <label class="field">
              <span>Module</span>
              <select id="module-filter">
                <option value="all">All modules</option>
              </select>
            </label>
            <p id="flow-meta">0 flows</p>
          </div>
          <div class="sidebar-section">
            <h2>Top-to-Bottom Flows</h2>
            <ul id="flow-list" class="flow-list"></ul>
          </div>
          <div class="sidebar-section">
            <h2>Steps</h2>
            <ol id="flow-steps" class="flow-steps"></ol>
          </div>
          <div class="sidebar-section">
            <h2>Selection</h2>
            <div id="node-inspector" class="node-inspector">Select a node to inspect</div>
            <button id="open-source-btn" type="button" disabled>Open source</button>
          </div>
        </aside>
        <section class="graph-stage">
          <div id="graph-canvas" aria-label="FlowDE graph"></div>
        </section>
      </main>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/**
 * Chooses the active editor workspace folder, falling back to the first workspace.
 */
function resolveWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    if (activeFolder) {
      return activeFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

/**
 * Creates a nonce for webview CSP script whitelisting.
 */
function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
