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
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  n: number;

  showSettings: boolean;
  showNodeBorders: boolean;
  showExport: boolean;
}

export interface Node {
  text: string;
  parentId: string | null;
  collapsed: boolean;
  unread: boolean;
  bookmarked: boolean;
  lastVisited?: number;
}

export interface NoteState {
  current: string;
  hoisted: string[];
  nodes: Record<string, Node>;
  generating: string | null;
}
