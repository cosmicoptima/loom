import {
  LoomView,
  LoomSiblingsView,
  LoomEditorPlugin,
  loomEditorPluginSpec,
  MakePromptFromPassagesModal,
} from './views';
import {
  Provider,
  LoomSettings,
  SearchResultState,
  Node,
  NoteState
} from './common';

import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
} from "obsidian";
import { ViewPlugin } from "@codemirror/view";

import { Configuration as AzureConfiguration, OpenAIApi as AzureOpenAIApi} from "azure-openai";
import { Configuration, OpenAIApi } from "openai";
import * as cohere from "cohere-ai";

import cl100k from "gpt-tokenizer";
import p50k from "gpt-tokenizer/esm/model/text-davinci-003";
import r50k from "gpt-tokenizer/esm/model/davinci";

import * as fs from "fs";
import { toRoman } from "roman-numerals";
import { v4 as uuidv4 } from "uuid";
const untildify = require("untildify") as any;

type LoomSettingStringKey = keyof {
  [K in keyof LoomSettings as LoomSettings[K] extends string
    ? K
    : never]: LoomSettings[K];
};
type LoomSettingKey = keyof {
  [K in keyof LoomSettings]: LoomSettings[K];
};

const DEFAULT_SETTINGS: LoomSettings = {
  openaiApiKey: "",
  openaiOrganization: "",

  cohereApiKey: "",
  textsynthApiKey: "",

  azureApiKey: "",
  azureEndpoint: "",

  ocpApiKey: "",
  ocpUrl: "",

  passageFolder: "",
  defaultPassageSeparator: "\\n\\n---\\n\\n",
  defaultPassageFrontmatter: "%r:\\n",

  provider: "ocp",
  model: "code-davinci-002",
  contextLength: 8000,
  maxTokens: 60,
  temperature: 1,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  n: 5,

  showSettings: false,
  showSearchBar: false,
  showNodeBorders: false,
  showExport: false,
};

type CompletionResult = { ok: true; completions: string[] } | { ok: false; status: number; message: string };

export default class LoomPlugin extends Plugin {
  settings: LoomSettings;
  state: Record<string, NoteState>;

  editor: Editor;
  statusBarItem: HTMLElement;

  openai: OpenAIApi;
  azure: AzureOpenAIApi;

  withFile<T>(callback: (file: TFile) => T): T | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return callback(file);
  }

  saveAndRender() {
	this.save();
	this.renderLoomViews();
	this.renderLoomSiblingsViews();
  }

  thenSaveAndRender(callback: () => void) {
    callback();
	this.saveAndRender();
  }

  wftsar(callback: (file: TFile) => void) {
    this.thenSaveAndRender(() => {
      this.withFile(callback);
    });
  }

  renderLoomViews() {
	const views = this.app.workspace.getLeavesOfType("loom").map((leaf) => leaf.view) as LoomView[];
	views.forEach((view) => view.render());
  }

  renderLoomSiblingsViews() {
	const views = this.app.workspace.getLeavesOfType("loom-siblings").map((leaf) => leaf.view) as LoomSiblingsView[];
	views.forEach((view) => view.render());
  }

  initializeProviders() {
	this.openai = new OpenAIApi(new Configuration({
	  apiKey: this.settings.openaiApiKey,
	  organization: this.settings.openaiOrganization,
	}));

	cohere.init(this.settings.cohereApiKey);

	if (!this.settings.azureApiKey || !this.settings.azureEndpoint) return;
	this.azure = new AzureOpenAIApi(new AzureConfiguration({
	  apiKey: this.settings.azureApiKey,
	  azure: {
		apiKey: this.settings.azureApiKey,
		endpoint: this.settings.azureEndpoint,
	  },
	}));
  }

  apiKeySet() {
    if (["openai", "openai-chat"].includes(this.settings.provider)) return !!this.settings.openaiApiKey;
	if (["azure", "azure-chat"].includes(this.settings.provider)) return !!this.settings.azureApiKey;
	if (this.settings.provider === "cohere") return !!this.settings.cohereApiKey;
	if (this.settings.provider === "textsynth") return !!this.settings.textsynthApiKey;
	if (this.settings.provider === "ocp") return !!this.settings.ocpApiKey;
	throw new Error(`Unknown provider ${this.settings.provider}`);
  }

  newNode(text: string, parentId: string | null, unread: boolean = false): [string, Node] {
    const id = uuidv4();
	const node: Node = {
	  text,
	  parentId,
	  collapsed: false,
	  unread,
	  bookmarked: false,
	  searchResultState: null,
	};
	return [id, node];
  }

  initializeNoteState(file: TFile) {
	const [rootId, root] = this.newNode(this.editor.getValue(), null);
    this.state[file.path] = {
	  current: rootId,
      hoisted: [] as string[],
	  searchTerm: "",
      nodes: { [rootId]: root },
	  generating: null,
    };
    this.saveAndRender();
  }

  ancestors(file: TFile, id: string): string[] {
    const state = this.state[file.path];
	let ancestors = [];
	let node: string | null = id;
	while (node) {
	  node = state.nodes[node].parentId;
	  if (node) ancestors.push(node);
	}
	return ancestors.reverse();
  }

  family(file: TFile, id: string): string[] {
    return [...this.ancestors(file, id), id];
  }

  fullText(file: TFile, id: string | null) {
	const state = this.state[file.path];

    let text = "";
    let current = id;
    while (current) {
      text = state.nodes[current].text + text;
      current = state.nodes[current].parentId;
    }
    return text;
  }

  breakAtPoint(file: TFile): (string | null)[] {
    // split the current node into:
    //   - parent node with text before cursor
    //   - child node with text after cursor
	
	const state = this.state[file.path];
    const current = state.current;

    // first, get the cursor's position in the full text
    const cursor = this.editor.getCursor();
    let cursorPos = 0;
    for (let i = 0; i < cursor.line; i++)
      cursorPos += this.editor.getLine(i).length + 1;
    cursorPos += cursor.ch;

    const family = this.family(file, current);
    const familyTexts = family.map((id) => state.nodes[id].text);

    // find the node that the cursor is in
    let i = cursorPos;
    let n = 0;
    while (true) {
      if (i < familyTexts[n].length) break;
	  // if the cursor is at the end of the last node, don't split, just return the current node
      if (n === family.length - 1)
		return [current, null];
      i -= familyTexts[n].length;
      n++;
    }

    const parentNode = family[n];
    const parentNodeText = familyTexts[n];

    // then, get the text before and after the cursor
    const before = parentNodeText.substring(0, i);
    const after = parentNodeText.substring(i);

    // then, set the in-range node's text to the text before the cursor
    this.state[file.path].nodes[parentNode].text = before;

    // get the in-range node's children, which will be moved later
    const children = Object.values(state.nodes).filter(
      (node) => node.parentId === parentNode
    );

    // then, create a new node with the text after the cursor
	const [childId, childNode] = this.newNode(after, parentNode);
	this.state[file.path].nodes[childId] = childNode;

    // move the children to under the after node
    children.forEach((child) => (child.parentId = childId));

    return [parentNode, childId];
  }

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.app.workspace.trigger("parse-style-settings")
    this.addSettingTab(new LoomSettingTab(this.app, this));

	this.initializeProviders();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Generating...");
    this.statusBarItem.style.display = "none";

    const completeCallback = (checking: boolean, callback: (file: TFile) => Promise<void>) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;

	  if (!this.apiKeySet()) return false;
	  if (!checking) callback(file);
	  return true;
	}

    this.addCommand({
      id: "complete",
      name: "Complete from current point",
      checkCallback: (checking: boolean) => completeCallback(checking, this.complete.bind(this)),
      hotkeys: [{ modifiers: ["Ctrl"], key: " " }],
    });

	this.addCommand({
	  id: "generate-siblings",
	  name: "Generate siblings of the current node",
	  checkCallback: (checking: boolean) => completeCallback(checking, this.generateSiblings.bind(this)),
	  hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: " " }],
	});

    const withState = (checking: boolean, callback: (state: NoteState) => void) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;

      const state = this.state[file.path];
      if (!state) this.initializeNoteState(file);

      if (!checking) callback(state);
      return true;
    };

    const withStateChecked = (
      checking: boolean,
      checkCallback: (state: NoteState) => boolean,
      callback: (state: NoteState) => void,
    ) => {
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return false;

      const state = this.state[file.path];
      if (!state) this.initializeNoteState(file);

      if (!checkCallback(state)) return false;

      if (!checking) callback(state);
      return true;
    };

    const openPane = (type: string, focus: boolean) => {
	  const panes = this.app.workspace.getLeavesOfType(type);
	  try {
		if (panes.length === 0)
		  this.app.workspace.getRightLeaf(false).setViewState({ type });
	    else if (focus) this.app.workspace.revealLeaf(panes[0]);
	  } catch (e) {} // expect "TypeError: Cannot read properties of null (reading 'children')"
	};
    const openLoomPane = (focus: boolean) => openPane("loom", focus);
	const openLoomSiblingsPane = (focus: boolean) => openPane("loom-siblings", focus);

    this.addCommand({
      id: "create-child",
      name: "Create child of current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:create-child", state.current);
        }),
    });

    this.addCommand({
      id: "create-sibling",
      name: "Create sibling of current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:create-sibling", state.current);
        }),
    });

    this.addCommand({
      id: "clone-current-node",
      name: "Clone current node",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clone", state.current);
        }),
    });

    this.addCommand({
      id: "break-at-point",
      name: "Split at current point",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:break-at-point", state.current);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "s" }],
    });

    this.addCommand({
      id: "break-at-point-create-child",
      name: "Split at current point and create child",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:break-at-point-create-child", state.current);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "c" }],
    });

    const canMerge = (state: NoteState, id: string, checking: boolean) => {
	  const parentId = state.nodes[id].parentId;
	  if (!parentId) {
        if (!checking) new Notice("Can't merge a root node with its parent");
		return false;
	  }
	  const nSiblings = Object.values(state.nodes).filter((n) => n.parentId === parentId).length;
	  if (nSiblings > 1) {
		if (!checking) new Notice("Can't merge this node with its parent; it has siblings");
		return false;
	  }
	  return true;
	}

    this.addCommand({
      id: "merge-with-parent",
      name: "Merge current node with parent",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => canMerge(state, state.current, checking),
          (state) => {
            this.app.workspace.trigger("loom:merge-with-parent", state.current);
          }
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "m" }],
    });
	
	const switchToSibling = (state: NoteState, delta: number) => {
	  const parentId = state.nodes[state.current].parentId;
	  const siblings = Object.entries(state.nodes)
	    .filter(([, node]) => node.parentId === parentId)
		.map(([id]) => id);
	  
	  if (siblings.length === 1) return;

	  const index = (siblings.indexOf(state.current) + delta + siblings.length) % siblings.length;
      this.app.workspace.trigger("loom:switch-to", siblings[index]);
	}

    this.addCommand({
      id: "switch-to-next-sibling",
      name: "Switch to next sibling",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => switchToSibling(state, 1)),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowDown" }],
    });

    this.addCommand({
      id: "switch-to-previous-sibling",
      name: "Switch to previous sibling",
	  checkCallback: (checking: boolean) =>
	    withState(checking, (state) => switchToSibling(state, -1)),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowUp" }],
    });

	const switchToParent = (state: NoteState) =>
	  this.app.workspace.trigger("loom:switch-to", state.nodes[state.current].parentId);

    this.addCommand({
      id: "switch-to-parent",
      name: "Switch to parent",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => state.nodes[state.current].parentId !== null,
          switchToParent,
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }],
    });

	const switchToChild = (state: NoteState) => {
      const children = Object.entries(state.nodes)
        .filter(([, node]) => node.parentId === state.current)
        .sort(
          ([, node1], [, node2]) =>
            (node2.lastVisited || 0) - (node1.lastVisited || 0)
        );

      if (children.length > 0)
        this.app.workspace.trigger("loom:switch-to", children[0][0]);
	}

    this.addCommand({
      id: "switch-to-child",
      name: "Switch to child",
      checkCallback: (checking: boolean) =>
        withState(checking, switchToChild),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }],
    });

	const canDelete = (state: NoteState, id: string, checking: boolean) => {
	  const rootNodes = Object.entries(state.nodes)
	    .filter(([, node]) => node.parentId === null)
		.map(([id]) => id);
	  if (rootNodes.length === 1 && rootNodes[0] === id) {
		if (!checking) new Notice("Can't delete the last root node");
		return false;
	  }
	  return true;
	}

    this.addCommand({
      id: "delete-current-node",
      name: "Delete current node",
      checkCallback: (checking: boolean) =>
        withStateChecked(
          checking,
          (state) => canDelete(state, state.current, checking),
          (state) => {
            this.app.workspace.trigger("loom:delete", [state.current]);
          }
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "Backspace" }],
    });

    this.addCommand({
      id: "clear-children",
      name: "Delete current node's children",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clear-children", state.current);
        }),
    });

    this.addCommand({
      id: "clear-siblings",
      name: "Delete current node's siblings",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:clear-siblings", state.current);
        }),
    });

    this.addCommand({
      id: "toggle-collapse-current-node",
      name: "Toggle whether current node is collapsed",
      checkCallback: (checking: boolean) =>
        withState(checking, (state) => {
          this.app.workspace.trigger("loom:toggle-collapse", state.current);
        }),
    });

    const getState = () => this.withFile((file) => this.state[file.path]);
    const getSettings = () => this.settings;

    this.addCommand({
	  id: "make-prompt-from-passages",
	  name: "Make prompt from passages",
	  callback: () => {
		if (this.settings.passageFolder.trim() === "") {
		  new Notice("Please set the passage folder in settings");
		  return;
		}
		new MakePromptFromPassagesModal(
          this.app,
	  	  getSettings,
	    ).open();
	  }
	});

    this.addCommand({
      id: "open-pane",
      name: "Open Loom pane",
      callback: () => openLoomPane(true),
    });

	this.addCommand({
	  id: "open-siblings-pane",
	  name: "Open Loom siblings pane",
	  callback: () => openLoomSiblingsPane(true),
	});

    this.addCommand({
      id: "debug-reset-state",
      name: "Debug: Reset state",
      callback: () => this.thenSaveAndRender(() => (this.state = {})),
    });

    this.addCommand({
      id: "debug-reset-hoist-stack",
      name: "Debug: Reset hoist stack",
	  callback: () => this.wftsar((file) => (this.state[file.path].hoisted = [])),
	});

    this.registerView(
      "loom",
      (leaf) => new LoomView(leaf, getState, getSettings)
    );
    this.registerView(
      "loom-siblings",
      (leaf) => new LoomSiblingsView(leaf, getState)
    );

    openLoomPane(true);
    openLoomSiblingsPane(false);

    const loomEditorPlugin = ViewPlugin.fromClass(
      LoomEditorPlugin,
      loomEditorPluginSpec
    );
    this.registerEditorExtension([loomEditorPlugin]);

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, view: MarkdownView) => {
          // @ts-expect-error
          const editorView = editor.cm;
          const plugin = editorView.plugin(loomEditorPlugin);
		  
          // get cursor position, so it can be restored later
          const cursor = editor.getCursor();

          // if this note has no state, initialize it and return
          if (!this.state[view.file.path]) {
            const [current, node] = this.newNode(editor.getValue(), null);
            this.state[view.file.path] = {
              current,
              hoisted: [] as string[],
			  searchTerm: "",
              nodes: { [current]: node },
              generating: null,
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
          // if not, edit the ancestor's text to match the in-range section of the editor's text
          const editNode = (i: number) => {
            const prefix = familyTexts.slice(0, i).join("");
            const suffix = familyTexts.slice(i + 1).join("");

            let newText = text.substring(prefix.length);
            newText = newText.substring(0, newText.length - suffix.length);

            this.state[view.file.path].nodes[ancestors[i]].text = newText;
          };

          const updateDecorations = () => {
            const ancestorLengths = ancestors.map((id) => [
              id,
              this.state[view.file.path].nodes[id].text.length,
            ]);
            plugin.state = { ...plugin.state, ancestorLengths };
            plugin.update();
          };

          for (let i = 0; i < ancestors.length; i++) {
            const textBefore = ancestorTexts.slice(0, i + 1).join("");
            if (!text.startsWith(textBefore)) {
              editNode(i);
              updateDecorations();
              return;
            }
          }
          this.state[view.file.path].nodes[current].text = text.slice(
            ancestorTexts.join("").length
          );

          updateDecorations();
		  this.saveAndRender();
		  
          // restore cursor position
          editor.setCursor(cursor);
        }
      )
    );

    this.registerEvent(
      // ignore ts2769; the obsidian-api declarations don't account for custom events
      // @ts-expect-error
      this.app.workspace.on("loom:switch-to", (id: string) =>
        this.wftsar((file) => {
          this.state[file.path].current = id;

          this.state[file.path].nodes[id].unread = false;
          this.state[file.path].nodes[id].lastVisited = Date.now();

		  // uncollapse the node's ancestors
          const ancestors = this.family(file, id).slice(0, -1);
          ancestors.forEach(
            (id) => (this.state[file.path].nodes[id].collapsed = false)
          );

		  // update the editor's text
          const cursor = this.editor.getCursor();
          const linesBefore = this.editor.getValue().split("\n");
          this.editor.setValue(this.fullText(file, id));

		  // if the text preceding the cursor has changed, move the cursor to the end of the text
		  // otherwise, restore the cursor position
          const linesAfter = this.editor
            .getValue()
            .split("\n")
            .slice(0, cursor.line + 1);
          for (let i = 0; i < cursor.line; i++)
            if (linesBefore[i] !== linesAfter[i]) {
			  const line = this.editor.lineCount() - 1;
			  const ch = this.editor.getLine(line).length;
			  this.editor.setCursor({ line, ch });
              return;
            }
		  this.editor.setCursor(cursor);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:toggle-collapse", (id: string) =>
        this.wftsar(
          (file) =>
            (this.state[file.path].nodes[id].collapsed =
              !this.state[file.path].nodes[id].collapsed)
        )
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:hoist", (id: string) =>
        this.wftsar((file) => this.state[file.path].hoisted.push(id))
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:unhoist", () =>
        this.wftsar((file) => this.state[file.path].hoisted.pop())
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:toggle-bookmark", (id: string) =>
        this.wftsar(
          (file) =>
            (this.state[file.path].nodes[id].bookmarked =
              !this.state[file.path].nodes[id].bookmarked)
        )
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:create-child", (id: string) =>
        this.withFile((file) => {
		  const [newId, newNode] = this.newNode("", id);
		  this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:create-sibling", (id: string) =>
        this.withFile((file) => {
		  const [newId, newNode] = this.newNode("", this.state[file.path].nodes[id].parentId);
		  this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clone", (id: string) =>
        this.withFile((file) => {
          const node = this.state[file.path].nodes[id];
		  const [newId, newNode] = this.newNode(node.text, node.parentId);
		  this.state[file.path].nodes[newId] = newNode;
          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:break-at-point", () =>
        this.withFile((file) => {
          const [, childId] = this.breakAtPoint(file);
		  if (childId) this.app.workspace.trigger("loom:switch-to", childId);
		})
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:break-at-point-create-child", () =>
        this.withFile((file) => {
          const [parentId] = this.breakAtPoint(file);
          if (parentId !== undefined) {
			const [newId, newNode] = this.newNode("", parentId);
			this.state[file.path].nodes[newId] = newNode;
            this.app.workspace.trigger("loom:switch-to", newId);
          }
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:merge-with-parent", (id: string) =>
        this.wftsar((file) => {
          const state = this.state[file.path];

		  if (!canMerge(state, id, false)) return;

          const parentId = state.nodes[id].parentId!;

		  // update the merged node's text
          state.nodes[parentId].text += state.nodes[id].text;

		  // move the children to the merged node
          const children = Object.entries(state.nodes).filter(
            ([, node]) => node.parentId === id
          );
          for (const [childId] of children)
            this.state[file.path].nodes[childId].parentId = parentId;

		  // switch to the merged node and delete the child node
          this.app.workspace.trigger("loom:switch-to", parentId);
          this.app.workspace.trigger("loom:delete", [id]);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:delete", (ids: string[]) =>
        this.wftsar((file) => {
		  const state = this.state[file.path];

		  ids = ids.filter((id) => canDelete(state, id, false));
		  if (ids.length === 0) return;

		  // remove the nodes from the hoist stack
          this.state[file.path].hoisted = state.hoisted.filter((id) => !ids.includes(id));

		  // add the nodes and their descendants to a list of nodes to delete

		  let deleted = [...ids];

		  const addChildren = (id: string) => {
			const children = Object.entries(state.nodes)
			  .filter(([, node]) => node.parentId === id)
			  .map(([id]) => id);
			deleted = deleted.concat(children);
			children.forEach(addChildren);
		  }
		  ids.forEach(addChildren);

		  // if the current node will be deleted, switch to its next sibling or its closest ancestor
		  if (deleted.includes(state.current)) {
            const parentId = state.nodes[state.current].parentId;
	    	const siblings = Object.entries(state.nodes)
	    	  .filter(([, node]) => node.parentId === parentId)
	    	  .map(([id]) => id);

			(() => {
			  // try to switch to the next sibling
	          if (siblings.some((id) => !deleted.includes(id))) {
	        	const index = siblings.indexOf(state.current);
	        	const nextSibling = siblings[(index + 1) % siblings.length];
	        	this.app.workspace.trigger("loom:switch-to", nextSibling);
		    	return;
	          }

			  // try to switch to the closest ancestor
			  let ancestorId = parentId;
			  while (ancestorId !== null) {
				if (!deleted.includes(ancestorId)) {
				  this.app.workspace.trigger("loom:switch-to", ancestorId);
				  return;
				}
				ancestorId = state.nodes[ancestorId].parentId;
			  }

			  // if all else fails, switch to a root node
			  const rootNodes = Object.entries(state.nodes)
			    .filter(([, node]) => node.parentId === null)
				.map(([id]) => id);
			  for (const id of rootNodes)
				if (!deleted.includes(id)) {
				  this.app.workspace.trigger("loom:switch-to", id);
				  return;
				}
			})();
		  }

		  // delete the nodes in the list
		  for (const id of deleted)
			delete this.state[file.path].nodes[id];
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-children", (id: string) =>
        this.wftsar((file) => {
          const children = Object.entries(this.state[file.path].nodes)
		    .filter(([, node]) => node.parentId === id)
			.map(([id]) => id);
		  this.app.workspace.trigger("loom:delete", children);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-siblings", (id: string) =>
        this.wftsar((file) => {
          const parentId = this.state[file.path].nodes[id].parentId;
          const siblings = Object.entries(this.state[file.path].nodes)
		    .filter(([id_, node]) => node.parentId === parentId && id_ !== id)
			.map(([id]) => id);
		  this.app.workspace.trigger("loom:delete", siblings);
        })
      )
    );

    this.registerEvent(
      this.app.workspace.on(
        // @ts-expect-error
        "loom:set-setting",
        (setting: string, value: any) => {
		  this.settings = { ...this.settings, [setting]: value };
		  this.saveAndRender();

		  // if changing showNodeBorders, update the editor
          if (setting === "showNodeBorders") {
            // @ts-expect-error
            const editor = this.editor.cm;
            const plugin = editor.plugin(loomEditorPlugin);

            plugin.state.showNodeBorders = this.settings.showNodeBorders;
            plugin.update();

            editor.focus();
          }
        }
      )
    );

	this.registerEvent(
	  // @ts-expect-error
	  this.app.workspace.on("loom:search", (term: string) => this.withFile((file) => {
		const state = this.state[file.path];

        this.state[file.path].searchTerm = term;
		if (!term) {
		  Object.keys(state.nodes).forEach((id) => {
		    this.state[file.path].nodes[id].searchResultState = null;
		  });
		  this.save(); // don't re-render
		  return;
		}

		const matches = Object.entries(state.nodes)
		  .filter(([, node]) => node.text.toLowerCase().includes(term.toLowerCase()))
		  .map(([id]) => id);

		let ancestors: string[] = [];
		for (const id of matches) {
		  let parentId = state.nodes[id].parentId;
		  while (parentId !== null) {
			ancestors.push(parentId);
			parentId = state.nodes[parentId].parentId;
		  }
		}

		Object.keys(state.nodes).forEach((id) => {
		  let searchResultState: SearchResultState;
		  if (matches.includes(id)) searchResultState = "result";
		  else if (ancestors.includes(id)) searchResultState = "ancestor";
		  else searchResultState = "none";
		  this.state[file.path].nodes[id].searchResultState = searchResultState;
		});

		this.save();
	  }))
	);

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:import", (path: string) =>
        this.wftsar((file) => {
          const fullPath = untildify(path);
          const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          this.state[file.path] = data;
          this.app.workspace.trigger("loom:switch-to", data.current);

          new Notice("Imported from " + fullPath);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:export", (path: string) =>
        this.wftsar((file) => {
          const fullPath = untildify(path);
          const json = JSON.stringify(this.state[file.path], null, 2);
          fs.writeFileSync(fullPath, json);

          new Notice("Exported to " + fullPath);
        })
      )
    );

	this.registerEvent(
	  this.app.workspace.on(
	    // @ts-expect-error
		"loom:make-prompt-from-passages",
		(
		  passages: string[],
		  rawSeparator: string,
		  rawFrontmatter: string,
		) => this.wftsar((file) => {
          const separator = rawSeparator.replace(/\\n/g, "\n");
		  const frontmatter = (index: number) => rawFrontmatter
		    .replace(/%n/g, (index + 1).toString())
			.replace(/%r/g, toRoman(index + 1))
			.replace(/\\n/g, "\n");

		  const passageTexts = passages.map((passage, index) => {
			return Object.entries(this.state[passage].nodes)
			  .filter(([, node]) => node.parentId === null)
			  .map(([, node]) => frontmatter(index) + node.text);
		  });
		  const text = `${passageTexts.join(separator)}${separator}${frontmatter(passages.length)}`;

		  const state = this.state[file.path];
		  const currentNode = state.nodes[state.current];

		  let id;
		  if (currentNode.text === "" && currentNode.parentId === null) {
			this.state[file.path].nodes[state.current].text = text;
			id = state.current;
		  } else {
	        const [newId, newNode] = this.newNode(text, null);
			this.state[file.path].nodes[newId] = newNode;
			id = newId;
		  }

		  this.app.workspace.trigger("loom:switch-to", id);
		})
	  )
	);

    const onFileOpen = (file: TFile) => {
      if (file.extension !== "md") return;

	  // if this file is new, initialize its state
      if (!this.state[file.path])
        this.initializeNoteState(file);

      const state = this.state[file.path];

	  // find this file's `MarkdownView`, then set `this.editor` to its editor
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          leaf.view instanceof MarkdownView &&
          leaf.view.file.path === file.path
        )
          this.editor = leaf.view.editor;
      });

	  // get the length of each ancestor's text,
	  // which will be passed to `LoomEditorPlugin` to mark ancestor nodes in the editor
      const ancestors = this.ancestors(file, state.current);
      const ancestorLengths = ancestors.map((id) =>
	    [id, state.nodes[id].text.length]);

	  // set `LoomEditorPlugin`'s state, then refresh it
      // @ts-expect-error
      const plugin = this.editor.cm.plugin(loomEditorPlugin);
      plugin.state = {
        ancestorLengths,
        showNodeBorders: this.settings.showNodeBorders,
      };
      plugin.update();

      this.renderLoomViews();
      this.renderLoomSiblingsViews();
	}

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => file && onFileOpen(file))
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView) this.editor = view.editor;
      })
    );

    this.registerEvent(
      this.app.workspace.on("resize", () => {
        this.renderLoomViews();
        this.renderLoomSiblingsViews();
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

    this.withFile((file) =>
      this.app.workspace.iterateRootLeaves((leaf) => {
        if (
          leaf.view instanceof MarkdownView &&
          leaf.view.file.path === file.path
        )
          this.editor = leaf.view.editor;
		onFileOpen(file);
      })
    );
  }

  async complete(file: TFile) {
	const state = this.state[file.path];
	this.breakAtPoint(file);
	await this.generate(file, state.current);
  }

  async generateSiblings(file: TFile) {
	const state = this.state[file.path];
	await this.generate(file, state.nodes[state.current].parentId);
  }

  async generate(file: TFile, rootNode: string | null) {
	// show the "Generating..." indicator in the status bar
	this.statusBarItem.style.display = "inline-flex";

    const state = this.state[file.path];
	
	this.state[file.path].generating = rootNode;

	// show the "Generating..." indicator in the loom view
	this.renderLoomViews();

    let prompt = `<|endoftext|>${this.fullText(file, rootNode)}`;
	
    // remove a trailing space if there is one
    // store whether there was, so it can be added back post-completion
    const trailingSpace = prompt.match(/\s+$/);
	prompt = prompt.replace(/\s+$/, "");
	
    // replace "\<" with "<", because obsidian tries to render html tags
	// and "\[" with "["
    prompt = prompt.replace(/\\</g, "<").replace(/\\\[/g, "[");

	// the tokenization and completion depend on the provider,
	// so call a different method depending on the provider
	const completionMethods: Record<Provider, (prompt: string) => Promise<CompletionResult>> = {
	  cohere: this.completeCohere,
	  textsynth: this.completeTextSynth,
      ocp: this.completeOCP,
	  openai: this.completeOpenAI,
	  "openai-chat": this.completeOpenAIChat,
	  azure: this.completeAzure,
	  "azure-chat": this.completeAzureChat,
	};
	let result;
	try {
	  result = await completionMethods[this.settings.provider].bind(this)(prompt);
	} catch (e) {
	  new Notice(`Error: ${e}`);
	  return;
	}
	if (!result.ok) {
	  new Notice(`Error ${result.status}: ${result.message}`);
	  return;
	}
	const rawCompletions = result.completions;

	// escape and clean up the completions
	const completions = rawCompletions.map((completion: string) => {
      if (!completion) completion = ""; // empty completions are null, apparently
      completion = completion.replace(/</g, "\\<"); // escape < for obsidian
	  completion = completion.replace(/\[/g, "\\["); // escape [ for obsidian

	  // if using a chat provider, always separate the prompt and completion with a space
	  // otherwise, deduplicate adjacent spaces between the prompt and completion
      if (["azure-chat", "openai-chat"].includes(this.settings.provider)) {
        if (!trailingSpace) completion = " " + completion;
      } else if (trailingSpace && completion[0] === " ")
        completion = completion.slice(1);

	  return completion;
	});

    // create a child of the current node for each completion
    let ids = [];
    for (let completion of completions) {
	  const [id, node] = this.newNode(completion, state.generating, true);
	  state.nodes[id] = node;
	  ids.push(id);
    }

    // switch to the first completion
    this.app.workspace.trigger("loom:switch-to", ids[0]);

    this.state[file.path].generating = null;
    this.saveAndRender();
    this.statusBarItem.style.display = "none";
  }

  async completeCohere(prompt: string) {
	const tokens = (await cohere.tokenize({ text: prompt })).body.token_strings;
	prompt = tokens.slice(-this.settings.contextLength).join("");

    const response = await cohere.generate({
      model: this.settings.model,
      prompt,
      max_tokens: this.settings.maxTokens,
      num_generations: this.settings.n,
      temperature: this.settings.temperature,
      p: this.settings.topP,
	  frequency_penalty: this.settings.frequencyPenalty,
	  presence_penalty: this.settings.presencePenalty,
    });

	const result: CompletionResult = response.statusCode === 200
	  ? { ok: true, completions: response.body.generations.map((generation) => generation.text) }
	  // @ts-expect-error
	  : { ok: false, status: response.statusCode!, message: response.body.message };
	return result;
  }

  async completeTextSynth(prompt: string) {
	const response = await requestUrl({
      url: `https://api.textsynth.com/v1/engines/${this.settings.model}/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.textsynthApiKey}`,
      },
	  throw: false,
      body: JSON.stringify({
        prompt,
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
      }),
	});

	let result: CompletionResult;
	if (response.status === 200) {
	  const completions = this.settings.n === 1 ? [response.json.text] : response.json.text;
	  result = { ok: true, completions };
	} else {
	  result = { ok: false, status: response.status, message: response.json.error };
	}
	return result;
  }

  trimOpenAIPrompt(prompt: string) {
    const cl100kModels = ["gpt-4-32k", "gpt-4-0314", "gpt-4-32k-0314", "gpt-3.5-turbo", "gpt-3.5-turbo-0301", "gpt-4-base"];
	const p50kModels = ["text-davinci-003", "text-davinci-002", "code-davinci-002", "code-davinci-001", "code-cushman-002", "code-cushman-001", "davinci-codex", "cushman-codex"];
	// const r50kModels = ["text-davinci-001", "text-curie-001", "text-babbage-001", "text-ada-001", "davinci", "curie", "babbage", "ada"];

	let tokenizer;
	if (cl100kModels.includes(this.settings.model)) tokenizer = cl100k;
	else if (p50kModels.includes(this.settings.model)) tokenizer = p50k;
    else tokenizer = r50k; // i expect that an unknown model will most likely be r50k

	return tokenizer.decode(tokenizer.encode(prompt, { disallowedSpecial: new Set() }).slice(-(this.settings.contextLength - this.settings.maxTokens)));
  }

  async completeOCP(prompt: string) {
	prompt = this.trimOpenAIPrompt(prompt);

    let url = this.settings.ocpUrl;

    if (!(url.startsWith("http://") || url.startsWith("https://")))
      url = "https://" + url;
    if (!url.endsWith("/")) url += "/";
	url = url.replace(/v1\//, "");
    url += "v1/completions";

    const response = await requestUrl({
	  url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.ocpApiKey}`,
        "Content-Type": "application/json",
      },
	  throw: false,
      body: JSON.stringify({
        prompt,
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
      }),
    });

	const result: CompletionResult = response.status === 200
	  ? { ok: true, completions: response.json.choices.map((choice: any) => choice.text) }
	  : { ok: false, status: response.status, message: "" };
	return result;
  }

  async completeOpenAI(prompt: string) {
	prompt = this.trimOpenAIPrompt(prompt);
	let result: CompletionResult;
	try {
	  const response = await this.openai.createCompletion({
        model: this.settings.model,
        prompt,
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
	  });
	  result = { ok: true, completions: response.data.choices.map((choice) => choice.text || "") };
	} catch (e) {
      result = { ok: false, status: e.response.status, message: e.response.data.error.message };
	}
	return result;
  }

  async completeOpenAIChat(prompt: string) {
	prompt = this.trimOpenAIPrompt(prompt);
	let result: CompletionResult;
	try {
	  const response = await this.openai.createChatCompletion({
        model: this.settings.model,
        messages: [{ role: "assistant", content: prompt }],
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
	  });
	  result = { ok: true, completions: response.data.choices.map((choice) => choice.message?.content || "") };
	} catch (e) {
	  result = { ok: false, status: e.response.status, message: e.response.data.error.message };
	}
	return result;
  }

  async completeAzure(prompt: string) {
	prompt = this.trimOpenAIPrompt(prompt);
	let result: CompletionResult;
	try {
	  const response = await this.azure.createCompletion({
        model: this.settings.model,
        prompt,
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
	  });
	  result = { ok: true, completions: response.data.choices.map((choice) => choice.text || "") };
	} catch (e) {
	  result = { ok: false, status: e.response.status, message: e.response.data.error.message };
	}
	return result;
  }

  async completeAzureChat(prompt: string) {
	prompt = this.trimOpenAIPrompt(prompt);
	let result: CompletionResult;
	try {
	  const response = await this.azure.createChatCompletion({
        model: this.settings.model,
        messages: [{ role: "assistant", content: prompt }],
        max_tokens: this.settings.maxTokens,
        n: this.settings.n,
        temperature: this.settings.temperature,
        top_p: this.settings.topP,
	    frequency_penalty: this.settings.frequencyPenalty,
	    presence_penalty: this.settings.presencePenalty,
	  });
	  result = { ok: true, completions: response.data.choices.map((choice) => choice.message?.content || "") };
	} catch (e) {
	  result = { ok: false, status: e.response.status, message: e.response.data.error.message };
	}
	return result;
  }

  async loadSettings() {
    const settings = (await this.loadData())?.settings || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async loadState() {
    this.state = (await this.loadData())?.state || {};
  }

  async save() {
    await this.saveData({ settings: this.settings, state: this.state });
    this.initializeProviders();
  }
}

// this relies on `LoomPlugin`, so it's here, not in `views.ts`

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
    disclaimerHeader.createEl("span", {
      text: " the Loom UI is not open by default. You can open it via one of the following methods:",
    });

    const methods = containerEl.createEl("ul");
    methods.createEl("li", {
      text: "Open the right sidebar and click the Loom icon.",
    });
    const method2 = methods.createEl("li");
    method2.createEl("span", {
      text: "Open the command palette, then search for and run the ",
    });
    method2.createEl("kbd", { text: "Loom: Open Loom pane" });
    method2.createEl("span", { text: " command." });

    const apiKeySetting = (name: string, key: LoomSettingStringKey) => {
      new Setting(containerEl)
        .setName(`${name} API key`)
        .setDesc(`Required if using ${name}`)
        .addText((text) =>
          text
            .setValue(this.plugin.settings[key])
            .onChange(async (value) => {
              this.plugin.settings[key] = value;
              await this.plugin.save();
            })
        );
    };
	
    const setting = (
	  name: string,
	  key: LoomSettingKey,
	  toText: (value: any) => string,
	  fromText: (text: string) => any
	) => {
      new Setting(containerEl).setName(name).addText((text) =>
	    text.setValue(toText(this.plugin.settings[key])).onChange(async (value) => {
		  // @ts-expect-error
		  this.plugin.settings[key] = fromText(value);
		  await this.plugin.save();
		})
	  );
	}

	const idSetting = (name: string, key: LoomSettingKey) =>
	  setting(name, key, (value) => value, (text) => text);

    apiKeySetting("Cohere", "cohereApiKey");
    apiKeySetting("TextSynth", "textsynthApiKey");
    apiKeySetting("OpenAI code-davinci-002 proxy", "ocpApiKey");

    new Setting(containerEl)
      .setName("OpenAI code-davinci-002 proxy URL")
      .setDesc("Required if using OCP")
      .addText((text) =>
        text.setValue(this.plugin.settings.ocpUrl).onChange(async (value) => {
          this.plugin.settings.ocpUrl = value;
          await this.plugin.save();
        })
      );

    apiKeySetting("OpenAI", "openaiApiKey");
	idSetting("OpenAI organization ID", "openaiOrganization");
    apiKeySetting("Azure", "azureApiKey")
	idSetting("Azure resource endpoint", "azureEndpoint");

    new Setting(containerEl)
      .setName("Passage folder location")
      .setDesc("Passages can be quickly combined into a multipart prompt")
      .addText((text) =>
        text.setValue(this.plugin.settings.passageFolder).onChange(async (value) => {
          this.plugin.settings.passageFolder = value;
          await this.plugin.save();
        })
      );
	
    idSetting("Default passage separator", "defaultPassageSeparator");
    idSetting("Default passage frontmatter", "defaultPassageFrontmatter");
  }
}
