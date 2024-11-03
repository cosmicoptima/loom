// In common.ts
export const PROVIDERS = [
  "cohere",
  "textsynth",
  "openai-compat",
  "openai",
  "openai-chat",
  "azure",
  "azure-chat",
  "anthropic",
  "openrouter",
  "ollama"  // Add this
];
export type Provider = (typeof PROVIDERS)[number];

type ProviderProps = {
  openai: { organization: string };
  "openai-chat": { organization: string };
  "openai-compat": { url: string };
  azure: { url: string };
  "azure-chat": { url: string };
  anthropic: { url: string };
  openrouter: { quantization: string };
  ollama: { url: string };  // Add this
};

type SharedPresetSettings = {
  name: string;

  model: string;
  contextLength: number;
  apiKey: string;
};

// In common.ts
export type ModelPreset<P extends Provider> = SharedPresetSettings & {
  provider: P;
  // Add missing properties
  organization?: string;  // For OpenAI
  url?: string;          // For Ollama, Azure, etc.
  quantization?: string; // For OpenRouter
};

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

export const getPreset = (settings: LoomSettings) =>
  settings.modelPresets[settings.modelPreset];

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
