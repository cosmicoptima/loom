export const PROVIDERS = ["cohere", "textsynth", "ocp", "openai", "openai-chat", "azure", "azure-chat", "anthropic"];
export type Provider = (typeof PROVIDERS)[number];

type ProviderProps = {
  "openai": { organization: string };
  "openai-chat": { organization: string };
  "ocp": { url: string };
  "azure": { url: string };
  "azure-chat": { url: string };
  "anthropic": { url: string };//, systemPrompt: string, userMessage: string };
};

type SharedPresetSettings = {
  name: string;

  model: string;
  contextLength: number;
  apiKey: string;
};

export type ModelPreset<P extends Provider> = SharedPresetSettings & (P extends keyof ProviderProps ? ProviderProps[P] : {}) & { provider: P };

export interface LoomSettings {
  passageFolder: string;
  defaultPassageSeparator: string;
  defaultPassageFrontmatter: string;

  logApiCalls: boolean;

  modelPresets: ModelPreset<Provider>[];
  modelPreset: number;

  visibility: Record<string, boolean>;
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  prepend: string;
  bestOf: number;
  n: number;
  systemPrompt: string;
  userMessage: string;

  showSettings: boolean;
  showSearchBar: boolean;
  showNodeBorders: boolean;
  showExport: boolean;

}

export const getPreset = (settings: LoomSettings) => settings.modelPresets[settings.modelPreset];

export type SearchResultState = "result" | "ancestor" | "none" | null;

export interface Node {
  text: string;
  parentId: string | null;
  collapsed: boolean;
  unread: boolean;
  bookmarked: boolean;
  lastVisited?: number;
  searchResultState: SearchResultState;
}

export interface NoteState {
  current: string;
  hoisted: string[];
  searchTerm: string;
  nodes: Record<string, Node>;
  generating: string | null;
}
