import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import GPT3Tokenizer from "gpt3-tokenizer";
import { Configuration, OpenAIApi } from "openai";
import { v4 as uuidv4 } from "uuid";

const tokenizer = new GPT3Tokenizer({ type: "codex" });

interface LoomSettings {
  apiKey: string;

  model: string;
  maxTokens: number;
  temperature: number;
  n: number;

  showSettings: boolean;
  cloneParentOnEdit: boolean;
}

const DEFAULT_SETTINGS: LoomSettings = {
  apiKey: "",
  model: "code-davinci-002",
  maxTokens: 30,
  n: 5,
  temperature: 1,
  showSettings: false,
  cloneParentOnEdit: true,
};

interface Node {
  text: string;
  parentId: string | null;
  unread: boolean;
  lastVisited?: number;
  collapsed: boolean;
}

interface NoteState {
  current: string;
  hoisted: string[];
  nodes: Record<string, Node>;
}

export default class LoomPlugin extends Plugin {
  settings: LoomSettings;
  state: Record<string, NoteState>;

  editor: Editor;
  view: LoomView;

  openai: OpenAIApi;

  withFile<T>(callback: (file: TFile) => T): T | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return callback(file);
  }

  thenSaveAndRender(callback: () => void) {
    callback();

    this.save();
    this.view.render();
  }

  wftsar(callback: (file: TFile) => void) {
    this.thenSaveAndRender(() => {
      this.withFile(callback);
    });
  }

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.addSettingTab(new LoomSettingTab(this.app, this));

    const configuration = new Configuration({
      apiKey: this.settings.apiKey,
    });
    this.openai = new OpenAIApi(configuration);

    this.addCommand({
      id: "loom-complete",
      name: "Complete",
      icon: "wand",
      callback: async () => this.complete(),
      hotkeys: [{ modifiers: ["Ctrl"], key: " " }],
    });

    const withState = (callback: (state: NoteState) => void) => {
      return this.withFile((file) => {
        const state = this.state[file.path];
        if (!state) this.initializeFile(file);

        callback(state);
      });
    };

    this.addCommand({
      id: "loom-create-child",
      name: "Create child of current node",
      icon: "plus",
      callback: () => withState((state) => this.app.workspace.trigger("loom:create-child", state.current)),
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "n" }],
    });

    this.addCommand({
      id: "loom-create-sibling",
      name: "Create sibling of current node",
      icon: "list-plus",
      callback: () => withState((state) => this.app.workspace.trigger("loom:create-sibling", state.current)),
      hotkeys: [{ modifiers: ["Alt"], key: "n" }],
    });

    this.addCommand({
      id: "loom-clone-current-node",
      name: "Clone current node",
      icon: "copy",
      callback: () => withState((state) => this.app.workspace.trigger("loom:clone", state.current)),
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "c" }],
    });

    this.addCommand({
      id: "loom-break-at-point",
      name: "Split current node into: parent node before cursor, child node after cursor, and new child node",
      callback: () => withState((state) => this.app.workspace.trigger("loom:break-at-point", state.current)),
      hotkeys: [{ modifiers: ["Alt"], key: "c" }],
    });

    this.addCommand({
      id: "loom-switch-to-next-sibling",
      name: "Switch to next sibling",
      icon: "arrow-down",
      callback: () => withState((state) => {
        const nextSibling = this.nextSibling(state.current, state);
        if (nextSibling) this.app.workspace.trigger("loom:switch-to", nextSibling);
      }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowDown" }],
    });

    this.addCommand({
      id: "loom-switch-to-previous-sibling",
      name: "Switch to previous sibling",
      icon: "arrow-up",
      callback: () => withState((state) => {
        const prevSibling = this.prevSibling(state.current, state);
        if (prevSibling) this.app.workspace.trigger("loom:switch-to", prevSibling);
      }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowUp" }],
    });

    this.addCommand({
      id: "loom-switch-to-parent",
      name: "Switch to parent",
      icon: "arrow-left",
      callback: () => withState((state) => {
        const parentId = state.nodes[state.current].parentId;
        if (parentId) this.app.workspace.trigger("loom:switch-to", parentId);
      }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }],
    });

    this.addCommand({
      id: "loom-switch-to-child",
      name: "Switch to child",
      icon: "arrow-right",
      callback: () => withState((state) => {
        const lastVisitedChild = this.lastVisitedChild(state);
        if (lastVisitedChild) this.app.workspace.trigger("loom:switch-to", lastVisitedChild);
      }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }],
    });

    this.addCommand({
      id: "loom-delete-current-node",
      name: "Delete current node",
      icon: "trash",
      callback: () => withState((state) => this.app.workspace.trigger("loom:delete", state.current)),
      hotkeys: [{ modifiers: ["Alt"], key: "Backspace" }],
    });

    this.addCommand({
      id: "loom-clear-children",
      name: "Delete current node's children",
      callback: () => withState((state) => this.app.workspace.trigger("loom:clear-children", state.current)),
    });

    this.addCommand({
      id: "loom-clear-siblings",
      name: "Delete current node's siblings",
      callback: () => withState((state) => this.app.workspace.trigger("loom:clear-siblings", state.current)),
    });

    this.addCommand({
      id: "loom-toggle-collapse-current-node",
      name: "Toggle whether current node is collapsed",
      icon: "folder-up",
      callback: () => withState((state) => this.app.workspace.trigger("loom:toggle-collapse", state.current)),
      hotkeys: [{ modifiers: ["Alt"], key: "e" }],
    });

    this.addCommand({
      id: "loom-open-pane",
      name: "Open Loom pane",
      callback: () => this.app.workspace.getRightLeaf(false).setViewState({ type: "loom" }),
    });

    this.addCommand({
      id: "loom-debug-reset-state",
      name: "Debug: Reset state",
      callback: () => this.thenSaveAndRender(() => this.state = {}),
    });

    this.registerView("loom", (leaf) => {
      this.view = new LoomView(leaf, () => this.withFile((file) => this.state[file.path]), () => this.settings);
      return this.view;
    });

    try {
      if (!(this.app.workspace.getLeavesOfType("loom").length > 0))
        this.app.workspace.getRightLeaf(false).setViewState({ type: "loom" });
    } catch (e) {
      console.error(e);
    }
    // TODO
    // `Cannot read properties of null (reading 'children')`
    //
    // this doesn't seem to cause any problems if wrapped in a try/catch

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, view: MarkdownView) => this.thenSaveAndRender(() => {
          // if this note has no state, initialize it
          if (!this.state[view.file.path])
            this.state[view.file.path] = {
              current: null as any, // `current` will be defined later
              hoisted: [] as string[],
              nodes: {},
            };

          // if this note has no current node, set it to the editor's text and return
          if (!this.state[view.file.path].current) {
            const current = uuidv4();
            this.state[view.file.path].current = current;
            this.state[view.file.path].nodes[current] = {
              text: editor.getValue(),
              parentId: null,
              unread: false,
              collapsed: false,
            };

            return;
          }

          const current = this.state[view.file.path].current;

          // `ancestors`: starts with the root node, ends with the parent of the current node
          let ancestors: string[] = [];
          let node: string | null = current;
          while (node) {
            node = this.state[view.file.path].nodes[node].parentId;
            if (node) ancestors.push(node);
          }
          ancestors = ancestors.reverse();

          // `ancestorTexts`: the text of each node in `ancestors`
          const text = editor.getValue();
          const ancestorTexts = ancestors.map(
            (id) => this.state[view.file.path].nodes[id].text
          );

          // `familyTexts`: `ancestorTexts` + the current node's text
          const familyTexts = ancestorTexts.concat(
            this.state[view.file.path].nodes[current].text
          );

          // for each ancestor, check if the editor's text starts with the ancestor's full text
          // if not, check if cpoe is enabled
          //   if so, `cloneParent`
          //   if not, `editNode`

          // `cloneParent`: create a sibling of the ancestor's parent with the new text
          const cloneParent = (i: number) => {
            const newPrefix = ancestorTexts.slice(0, i).join("");
            const newText = text.substring(newPrefix.length);

            const id = uuidv4();
            this.state[view.file.path].nodes[id] = {
              text: newText,
              parentId: i === 0 ? null : ancestors[i - 1],
              unread: false,
              collapsed: false,
            };

            this.app.workspace.trigger("loom:switch-to", id);
          };

          // `editNode`: edit the ancestor's text to match the in-range section of the editor's text
          const editNode = (i: number) => {
            const prefix = familyTexts.slice(0, i).join("");
            const suffix = familyTexts.slice(i + 1).join("");

            let newText = text.substring(prefix.length);
            newText = newText.substring(0, newText.length - suffix.length);

            this.state[view.file.path].nodes[ancestors[i]].text = newText;
          };

          for (let i = 0; i < ancestors.length; i++) {
            const textBefore = ancestorTexts.slice(0, i + 1).join("");

            if (!text.startsWith(textBefore)) {
              if (this.settings.cloneParentOnEdit) cloneParent(i);
              else editNode(i);
                
              return;
            }
          }

          // if the edited node has children and cpoe is enabled, `cloneParent`
          const children = Object.values(
            this.state[view.file.path].nodes
          ).filter((node) => node.parentId === current);
          const fullText = familyTexts.join(""); // don't clone parent if the text is the same
          if (children.length > 0 && text !== fullText && this.settings.cloneParentOnEdit)
            cloneParent(ancestors.length);

          this.state[view.file.path].nodes[current].text = text.slice(
            ancestorTexts.join("").length
          );
        })
      )
    );

    this.registerEvent(
      // ignore ts2769; the obsidian-api declarations don't account for custom events
      // @ts-ignore
      this.app.workspace.on("loom:switch-to", (id: string) => this.wftsar((file) => {
        this.state[file.path].current = id;
        this.state[file.path].nodes[id].unread = false;
        this.state[file.path].nodes[id].lastVisited = Date.now();

        this.editor.setValue(this.fullText(id, this.state[file.path]));
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:toggle-collapse", (id: string) => this.wftsar((file) =>
        this.state[file.path].nodes[id].collapsed =
          !this.state[file.path].nodes[id].collapsed
      ))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:hoist", (id: string) => this.wftsar((file) =>
        this.state[file.path].hoisted.push(id)
      ))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:unhoist", () => this.wftsar((file) =>
        this.state[file.path].hoisted.pop()
      ))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:create-child", (id: string) => this.withFile((file) => {
        const newId = uuidv4();
        this.state[file.path].nodes[newId] = {
          text: "",
          parentId: id,
          unread: false,
          collapsed: false,
        };

        this.app.workspace.trigger("loom:switch-to", newId);
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:create-sibling", (id: string) => this.withFile((file) => {
        const newId = uuidv4();
        this.state[file.path].nodes[newId] = {
          text: "",
          parentId: this.state[file.path].nodes[id].parentId,
          unread: false,
          collapsed: false,
        };

        this.app.workspace.trigger("loom:switch-to", newId);
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:clone", (id: string) => this.withFile((file) => {
        const newId = uuidv4();
        this.state[file.path].nodes[newId] = {
          text: this.state[file.path].nodes[id].text,
          parentId: this.state[file.path].nodes[id].parentId,
          unread: false,
          collapsed: false,
        };

        this.app.workspace.trigger("loom:switch-to", newId);
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:break-at-point", () => this.withFile((file) => {
        // split the current node into:
        //   - parent node with text before cursor
        //   - child node with text after cursor
        //   - new child node with no text

        const current = this.state[file.path].current;
        const cursor = this.editor.getCursor();

        // first, get the cursor's position in the full text
        let cursorPos = 0;
        for (let i = 0; i < cursor.line; i++)
          cursorPos += this.editor.getLine(i).length + 1;
        cursorPos += cursor.ch;

        const family = this.family(current, this.state[file.path]);
        const familyTexts = family.map((id) => this.state[file.path].nodes[id].text);

        // find the node that the cursor is in
        let i = cursorPos;
        let n = 0;
        while (i > 0) {
          i -= familyTexts[n].length;
          n++;
        }
        const inRangeNode = family[n - 1];
        const inRangeNodeText = familyTexts[n - 1];
        const currentCursorPos = -i;

        // then, get the text before and after the cursor
        const before = inRangeNodeText.substring(0, currentCursorPos);
        const after = inRangeNodeText.substring(currentCursorPos);

        // then, set the in-range node's text to the text before the cursor
        this.state[file.path].nodes[inRangeNode].text = before;

        // get the in-range node's children, which will be moved later
        const children = Object.values(
          this.state[file.path].nodes
        ).filter((node) => node.parentId === inRangeNode);

        // then, create a new node with the text after the cursor
        const afterId = uuidv4();
        this.state[file.path].nodes[afterId] = {
          text: after,
          parentId: inRangeNode,
          unread: false,
          collapsed: false,
        };

        // then, create a new node with no text
        const newId = uuidv4();
        this.state[file.path].nodes[newId] = {
          text: "",
          parentId: inRangeNode,
          unread: false,
          collapsed: false,
        };

        // move the children to under the after node
        children.forEach((child) => child.parentId = afterId);

        // switch to the new node
        this.app.workspace.trigger("loom:switch-to", newId);
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:delete", (id: string) => this.wftsar((file) => {
        if (this.state[file.path].hoisted.includes(id))
          this.state[file.path].hoisted = this.state[file.path].hoisted.filter(
            (hoistedId) => hoistedId !== id
          );

        let nextId = this.nextSibling(id, this.state[file.path]);
        if (!nextId) nextId = this.state[file.path].nodes[id].parentId;
        if (!nextId) return;

        let deletedIds = [id];

        const deleteChildren = (id: string) => {
          for (const [id_, node] of Object.entries(this.state[file.path].nodes))
            if (node.parentId === id) {
              deleteChildren(id_);
              delete this.state[file.path].nodes[id_];
              deletedIds.push(id_);
            }
        };

        delete this.state[file.path].nodes[id];
        deleteChildren(id);

        if (deletedIds.includes(this.state[file.path].current)) {
          if (deletedIds.includes(nextId)) {
            new Notice("WARNING: deleted current node and fallback");
            return;
          } // TODO
          this.app.workspace.trigger("loom:switch-to", nextId);
        }
      }))
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:clear-children", (id: string) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        const children = Object.entries(this.state[file.path].nodes).filter(
          ([, node]) => node.parentId === id
        );
        for (const [id, ] of children) this.app.workspace.trigger("loom:delete", id);

        this.save();
        this.view.render();
      })
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:clear-siblings", (id: string) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;

        const parentId = this.state[file.path].nodes[id].parentId;
        const siblings = Object.entries(this.state[file.path].nodes).filter(
          ([id_, node]) => node.parentId === parentId && id_ !== id
        );
        for (const [id, ] of siblings) this.app.workspace.trigger("loom:delete", id);

        this.save();
        this.view.render();
      })
    );

    this.registerEvent(
      // @ts-ignore
      this.app.workspace.on("loom:set-setting", (setting: string, value: any) => {
        this.settings = { ...this.settings, [setting]: value };
        this.save();
        this.view.render();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;

        this.view.render();
        this.app.workspace.iterateRootLeaves((leaf) => {
          if (
            leaf.view instanceof MarkdownView &&
            leaf.view.file.path === file.path
          )
            this.editor = leaf.view.editor;
        });

        if (!this.state[file.path]) {
          this.initializeFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;

        const view = leaf.view;
        if (view instanceof MarkdownView) this.editor = view.editor;
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.state[file.path] = this.state[oldPath];
        delete this.state[oldPath];
        this.save();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        delete this.state[file.path];
        this.save();
      })
    );

    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return;

    this.app.workspace.iterateRootLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file.path === activeFile.path
      )
        this.editor = leaf.view.editor;
    });
  }

  initializeFile(file: TFile) {
    // coerce to NoteState because `current` will be defined
    this.state[file.path] = {
      hoisted: [] as string[],
      nodes: {},
    } as NoteState;

    const text = this.editor.getValue();

    const id = uuidv4();
    this.state[file.path].nodes[id] = {
      text,
      parentId: null,
      unread: false,
      collapsed: false,
    };
    this.state[file.path].current = id;

    this.save();
    this.view.render();
  }

  async complete() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;

    const state = this.state[file.path];
    let prompt = this.fullText(state.current, state);

    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    prompt = prompt.replace(/\\</g, "<");

    const bpe = tokenizer.encode(prompt).bpe;
    const tokens = bpe.slice(
      Math.max(0, bpe.length - (8000 - this.settings.maxTokens)),
      bpe.length
    );
    prompt = tokenizer.decode(tokens);

    let completions;
    try {
      completions = (
        await this.openai.createCompletion({
          model: this.settings.model,
          prompt,
          max_tokens: this.settings.maxTokens,
          n: this.settings.n,
          temperature: 1,
        })
      ).data.choices.map((choice) => choice.text);
    } catch (e) {
      if (e.response.status === 401)
        new Notice(
          "OpenAI API key is invalid. Please provide a valid key in the settings."
        );
      else if (e.response.status === 429)
        new Notice("OpenAI API rate limit exceeded.");
      else
        new Notice(
          "Unknown OpenAI API error: " + e.response.data.error.message
        );

      return;
    }

    let ids = [];
    for (const completion of completions) {
      let completion_ = completion?.replace(/</g, "\\<");
      if (!completion_) continue; // i've never seen this happen

      if (trailingSpace && completion_[0] === " ")
        completion_ = completion_.slice(1);

      const id = uuidv4();
      state.nodes[id] = {
        text: completion_,
        parentId: state.current,
        unread: true,
        collapsed: false,
      };
      ids.push(id);
    }

    if (ids.length > 0) this.app.workspace.trigger("loom:switch-to", ids[0]);

    this.save();
    this.view.render();
  }

  fullText(id: string, state: NoteState) {
    let text = "";

    let current: string | null = id;
    while (current) {
      text = state.nodes[current].text + text;
      current = state.nodes[current].parentId;
    }

    return text;
  }

  family(id: string, state: NoteState) {
    let ids = [id];

    let current: string | null = id;
    while (current) {
      current = state.nodes[current].parentId;
      if (current) ids.push(current);
    }
    ids = ids.reverse();

    return ids;
  }

  nextSibling(id: string, state: NoteState) {
    const parentId = state.nodes[id].parentId;
    const siblings = Object.entries(state.nodes)
      .filter(([, node]) => node.parentId === parentId)
      .map(([id]) => id);

    if (siblings.length === 1) return null;

    const nextIndex = (siblings.indexOf(id) + 1) % siblings.length;
    return siblings[nextIndex];
  }

  prevSibling(id: string, state: NoteState) {
    const parentId = state.nodes[id].parentId;
    const siblings = Object.entries(state.nodes)
      .filter(([, node]) => node.parentId === parentId)
      .map(([id]) => id);

    if (siblings.length === 1) return null;

    const prevIndex =
      (siblings.indexOf(id) + siblings.length - 1) % siblings.length;
    return siblings[prevIndex];
  }

  lastVisitedChild(state: NoteState) {
    const children = Object.entries(state.nodes)
      .filter(([, node]) => node.parentId === state.current)
      .sort(
        ([, node1], [, node2]) =>
          (node2.lastVisited || 0) - (node1.lastVisited || 0)
      );

    if (children.length === 0) return null;
    return children[0][0];
  }

  async loadSettings() {
    const settings = await (async () => {
      const data = await this.loadData();
      if (data) return data.settings || {};
      return {};
    })();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async loadState() {
    this.state = await (async () => {
      const data = await this.loadData();
      if (data) return data.state || {};
      return {};
    })();
  }

  async save() {
    await this.saveData({ settings: this.settings, state: this.state });
  }
}

class LoomView extends ItemView {
  getNoteState: () => NoteState | null;
  getSettings: () => LoomSettings;

  constructor(leaf: WorkspaceLeaf, getNoteState: () => NoteState | null, getSettings: () => LoomSettings) {
    super(leaf);

    this.getNoteState = getNoteState;
    this.getSettings = getSettings;
    this.render();
  }

  render() {
    const scroll = (this.containerEl as HTMLElement).scrollTop;

    this.containerEl.empty();
    this.containerEl.addClass("loom");

    const navButtonsContainer = this.containerEl.createDiv({
      cls: "nav-buttons-container loom-buttons",
    });

    const settingsButton = navButtonsContainer.createDiv({
      cls: `clickable-icon nav-action-button${this.getSettings().showSettings ? " is-active" : ""}`,
      attr: { "aria-label": "Settings" },
    });
    setIcon(settingsButton, "settings");
    settingsButton.addEventListener("click", () => {
      this.app.workspace.trigger("loom:set-setting", "showSettings", !this.getSettings().showSettings);
    });

    const cpoeButton = navButtonsContainer.createDiv({
      cls: `clickable-icon nav-action-button${this.getSettings().cloneParentOnEdit ? " is-active" : ""}`,
      attr: { "aria-label": "Don't allow nodes with children to be edited; clone them instead" },
    });
    setIcon(cpoeButton, "copy");
    cpoeButton.addEventListener("click", () => {
      this.app.workspace.trigger("loom:set-setting", "cloneParentOnEdit", !this.getSettings().cloneParentOnEdit);
    });

    const state = this.getNoteState();
    const container = this.containerEl.createDiv({
      cls: "outline",
    });

    const settings = container.createDiv({ cls: `loom-settings${this.getSettings().showSettings ? "" : " hidden"}` });

    const modelDiv = settings.createDiv({ cls: "loom-setting" });
    modelDiv.createEl("label", { text: "Model" });
    const modelInput = modelDiv.createEl("input", {
      type: "text",
      value: this.getSettings().model,
      attr: { id: "loom-model" },
    });
    modelInput.addEventListener("blur", (e) => {
      this.app.workspace.trigger(
        "loom:set-setting",
        "model",
        (e.target as HTMLInputElement).value,
      );
    });

    const maxTokensDiv = settings.createDiv({ cls: "loom-setting" });
    maxTokensDiv.createEl("label", { text: "Length (in tokens)" });
    const maxTokensInput = maxTokensDiv.createEl("input", {
      type: "number",
      value: String(this.getSettings().maxTokens),
      attr: { id: "loom-max-tokens" },
    });
    maxTokensInput.addEventListener("blur", (e) => {
      this.app.workspace.trigger(
        "loom:set-setting",
        "maxTokens",
        parseInt((e.target as HTMLInputElement).value),
      );
    });

    const temperatureDiv = settings.createDiv({ cls: "loom-setting" });
    temperatureDiv.createEl("label", { text: "Temperature" });
    const temperatureInput = temperatureDiv.createEl("input", {
      type: "number",
      value: String(this.getSettings().temperature),
      attr: { id: "loom-temperature" },
    });
    temperatureInput.addEventListener("blur", (e) => {
      this.app.workspace.trigger(
        "loom:set-setting",
        "temperature",
        parseFloat((e.target as HTMLInputElement).value),
      );
    });

    const nDiv = settings.createDiv({ cls: "loom-setting" });
    nDiv.createEl("label", { text: "Number of completions" });
    const nInput = nDiv.createEl("input", {
      type: "number",
      value: String(this.getSettings().n),
      attr: { id: "loom-n" },
    });
    nInput.addEventListener("blur", (e) => {
      this.app.workspace.trigger(
        "loom:set-setting",
        "n",
        parseInt((e.target as HTMLInputElement).value),
      );
    });

    if (!state) {
      container.createEl("div", {
        cls: "pane-empty",
        text: "No note selected.",
      });
      return;
    }

    const nodeEntries = Object.entries(state.nodes);

    let onlyRootNode: string | null = null;
    const rootNodes = nodeEntries.filter(([, node]) => node.parentId === null);
    if (rootNodes.length === 1) onlyRootNode = rootNodes[0][0];

    const renderNode = (node: Node, id: string, container: HTMLElement) => {
      const childContainer = container.createDiv({});

      const nodeDiv = childContainer.createDiv({
        cls: `is-clickable outgoing-link-item tree-item-self loom-node${
          node.unread ? " loom-node-unread" : ""
        }${id === state.current ? " is-active" : ""}`,
      });

      const hasChildren =
        nodeEntries.filter(([, node]) => node.parentId === id).length > 0;
      if (hasChildren) {
        const collapseDiv = nodeDiv.createDiv({
          cls: `collapse-icon loom-collapse${
            node.collapsed ? " is-collapsed" : ""
          }`,
        });
        setIcon(collapseDiv, "right-triangle");
        collapseDiv.addEventListener("click", () =>
          this.app.workspace.trigger("loom:toggle-collapse", id)
        );
      }

      if (node.unread) nodeDiv.createDiv({ cls: "loom-node-unread-indicator" });
      const nodeText = nodeDiv.createEl(node.text ? "span" : "em", {
        cls: "loom-node-inner tree-item-inner",
        text: node.text || "No text",
      });
      nodeText.addEventListener("click", () =>
        this.app.workspace.trigger("loom:switch-to", id)
      );

      const iconsDiv = nodeDiv.createDiv({ cls: "loom-icons" });
      nodeDiv.createDiv({ cls: "loom-spacer" });

      if (state.hoisted[state.hoisted.length - 1] === id) {
        const unhoistDiv = iconsDiv.createEl("div", {
          cls: "loom-icon",
          attr: { "aria-label": "Unhoist" },
        });
        setIcon(unhoistDiv, "arrow-down");
        unhoistDiv.addEventListener("click", () =>
          this.app.workspace.trigger("loom:unhoist")
        );
      } else {
        const hoistDiv = iconsDiv.createEl("div", {
          cls: "loom-icon",
          attr: { "aria-label": "Hoist" },
        });
        setIcon(hoistDiv, "arrow-up");
        hoistDiv.addEventListener("click", () =>
          this.app.workspace.trigger("loom:hoist", id)
        );
      }

      const createSiblingDiv = iconsDiv.createEl("div", {
        cls: "loom-icon",
        attr: { "aria-label": "Create sibling" },
      });
      setIcon(createSiblingDiv, "list-plus");
      createSiblingDiv.addEventListener("click", () =>
        this.app.workspace.trigger("loom:create-sibling", id)
      );

      const createChildDiv = iconsDiv.createEl("div", {
        cls: "loom-icon",
        attr: { "aria-label": "Create child" },
      });
      setIcon(createChildDiv, "plus");
      createChildDiv.addEventListener("click", () =>
        this.app.workspace.trigger("loom:create-child", id)
      );

      if (id !== onlyRootNode) {
        const trashDiv = iconsDiv.createEl("div", {
          cls: "loom-icon",
          attr: { "aria-label": "Delete" },
        });
        setIcon(trashDiv, "trash");
        trashDiv.addEventListener("click", () =>
          this.app.workspace.trigger("loom:delete", id)
        );
      }

      if (!node.collapsed) {
        const childrenDiv = childContainer.createDiv({ cls: "loom-children" });
        renderChildren(id, childrenDiv);
      }
    };

    const renderChildren = (
      parentId: string | null,
      container: HTMLElement
    ) => {
      const children = nodeEntries.filter(
        ([, node]) => node.parentId === parentId
      );
      for (const [id, node] of children) renderNode(node, id, container);
    };

    if (state.hoisted.length > 0)
      renderNode(
        state.nodes[state.hoisted[state.hoisted.length - 1]],
        state.hoisted[state.hoisted.length - 1],
        container
      );
    else renderChildren(null, container);

    this.containerEl.scrollTop = scroll;
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

class LoomSettingTab extends PluginSettingTab {
  plugin: LoomPlugin;

  constructor(app: App, plugin: LoomPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    const disclaimerHeader = containerEl.createEl("p");

    disclaimerHeader.createEl("strong", { text: "To those new to Obsidian:" });
    disclaimerHeader.createEl("span", { text: " the Loom UI is not open by default. You can open it via one of the following methods:" });

    const methods = containerEl.createEl("ul");
    methods.createEl("li", { text: "Open the right sidebar and click the Loom icon." });
    const method2 = methods.createEl("li");
    method2.createEl("span", { text: "Open the command palette, then search for and run the " });
    method2.createEl("kbd", { text: "Loom: Open Loom pane" });
    method2.createEl("span", { text: " command." });

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("Required")
      .addText((text) =>
        text.setValue(this.plugin.settings.apiKey).onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.save();
        })
      );

    new Setting(containerEl).setName("Model").addText((text) =>
      text.setValue(this.plugin.settings.model).onChange(async (value) => {
        this.plugin.settings.model = value;
        await this.plugin.save();
      })
    );

    new Setting(containerEl).setName("Length (in tokens)").addText((text) =>
      text
        .setValue(this.plugin.settings.maxTokens.toString())
        .onChange(async (value) => {
          this.plugin.settings.maxTokens = parseInt(value);
          await this.plugin.save();
        })
    );

    new Setting(containerEl).setName("Temperature").addText((text) =>
      text
        .setValue(this.plugin.settings.temperature.toString())
        .onChange(async (value) => {
          this.plugin.settings.temperature = parseFloat(value);
          await this.plugin.save();
        })
    );

    new Setting(containerEl).setName("Number of completions").addText((text) =>
      text
        .setValue(this.plugin.settings.n.toString())
        .onChange(async (value) => {
          this.plugin.settings.n = parseInt(value);
          await this.plugin.save();
        })
    );
  }
}
