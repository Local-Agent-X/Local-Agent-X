export interface AppManifest {
  generatedAt: string;
  pages: PageEntry[];
  settingsTabs: TabEntry[];
  agentTabs: TabEntry[];
  apiRoutes: RouteEntry[];
  tools: ToolSummary[];
  apps: AppEntry[];
  configFiles: ConfigFileEntry[];
  bridges: string[];
  integrations: string[];
}

export interface PageEntry { name: string; path: string; description: string }
export interface TabEntry { name: string; id: string; description: string }
export interface RouteEntry { method: string; path: string; description: string }
export interface ToolSummary { name: string; description: string; readOnly: boolean }
export interface AppEntry { name: string; path: string; files: string[] }
export interface ConfigFileEntry { path: string; description: string; agentEditable: boolean }
