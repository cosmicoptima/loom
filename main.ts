import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { Configuration, OpenAIApi } from "openai";

interface GPT3Settings {
  apiKey: string;
  model: string;
  maxTokens: number;
  nodesFolder: string;
}

const DEFAULT_SETTINGS: GPT3Settings = {
  apiKey: "",
  model: "davinci",
  maxTokens: 8,
  nodesFolder: "nodes",
};

export default class GPT3Plugin extends Plugin {
  settings: GPT3Settings;
  openai: OpenAIApi;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new GPT3SettingTab(this.app, this));

    const configuration = new Configuration({
      apiKey: this.settings.apiKey,
    });
    this.openai = new OpenAIApi(configuration);

    this.addCommand({
      id: "gpt-3-complete",
      name: "Complete",
      icon: "wand",
      editorCallback: async (editor: Editor, view: MarkdownView) =>
        this.complete(this.settings.model, this.settings.maxTokens, editor),
    });

    this.registerView(
      "loom",
      (leaf) => new LoomView(leaf),
    );
    const loomExists = this.app.workspace.getLeavesOfType("loom").length > 0;
    if (!loomExists)
      this.app.workspace.getRightLeaf(false).setViewState({
        type: "loom",
      });
  }

  async complete(model: string, maxTokens: number, editor: Editor) {
    let prompt;

    const selection = editor.getSelection();
    if (selection) prompt = selection;
    else
      prompt = (() => {
        const cursorPosition = editor.getCursor();
        const text = editor.getValue().split("\n");

        let prompt = text.slice(0, cursorPosition.line + 1);
        prompt[cursorPosition.line] = prompt[cursorPosition.line].slice(
          0,
          cursorPosition.ch
        );
        return prompt.join("\n");
      })();

    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    let completion = (
      await this.openai.createCompletion({
        model,
        prompt,
        max_tokens: maxTokens,
        temperature: 1,
      })
    ).data.choices[0].text;
    if (trailingSpace && completion[0] === " ")
      completion = completion.slice(1);

    editor.replaceSelection(selection + completion);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class LoomView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);

    this.containerEl.empty();
  }

  getViewType(): string {
    return "loom";
  }

  getDisplayText(): string {
    return "Loom";
  }

  getIcon(): string {
    return "network";
  }
}

class GPT3SettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Required")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Model").addText((text) =>
      text.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.saveSettings();
      })
    );

    new Setting(containerEl).setName("Length (in tokens)").addText((text) =>
      text
        .setValue(this.plugin.settings.maxTokens.toString())
        .onChange(async (value) => {
          this.plugin.settings.maxTokens = parseInt(value);
          await this.plugin.saveSettings();
        })
    );

    new Setting(containerEl).setName("Nodes folder").addText((text) =>
      text
        .setValue(this.plugin.settings.nodesFolder)
        .onChange(async (value) => {
          this.plugin.settings.nodesFolder = value;
          await this.plugin.saveSettings();
        })
    );
  }
}
