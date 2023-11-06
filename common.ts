export const PROVIDERS = ["cohere", "textsynth", "ocp", "openai", "openai-chat", "azure", "azure-chat"];
export type Provider = (typeof PROVIDERS)[number];

export interface LoomSettings {
  openaiApiKey: string;
  openaiOrganization: string;

  cohereApiKey: string;
  textsynthApiKey: string;

  azureApiKey: string;
  azureEndpoint: string;

  ocpApiKey: string;
  ocpUrl: string;

  passageFolder: string;
  defaultPassageSeparator: string;
  defaultPassageFrontmatter: string;

  provider: Provider;
  model: string;
  contextLength: number;
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  prepend: string;
  bestOf: number;
  n: number;

  showSettings: boolean;
  showSearchBar: boolean;
  showNodeBorders: boolean;
  showExport: boolean;
}

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
