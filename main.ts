import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";
import { Range } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginSpec,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { Configuration as AzureConfiguration, OpenAIApi as AzureOpenAIApi} from "azure-openai";
import { Configuration, OpenAIApi } from "openai";
import * as cohere from "cohere-ai";
import GPT3Tokenizer from "gpt3-tokenizer";

import * as fs from "fs";
import { v4 as uuidv4 } from "uuid";
const dialog = require("electron").remote.dialog;
const untildify = require("untildify") as any;

const tokenizer = new GPT3Tokenizer({ type: "codex" }); // TODO depends on model

const PROVIDERS = ["cohere", "textsynth", "ocp", "openai", "openai-chat", "azure", "azure-chat"];
type Provider = (typeof PROVIDERS)[number];

interface LoomSettings {
  openaiApiKey: string;
  cohereApiKey: string;
  textsynthApiKey: string;

  azureApiKey: string;
  azureEndpoint: string;

  ocpApiKey: string;
  ocpUrl: string;

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

type LoomSettingKey = keyof {
  [K in keyof LoomSettings as LoomSettings[K] extends string
    ? K
    : never]: LoomSettings[K];
};

const DEFAULT_SETTINGS: LoomSettings = {
  openaiApiKey: "",
  cohereApiKey: "",
  textsynthApiKey: "",

  azureApiKey: "",
  azureEndpoint: "",

  ocpApiKey: "",
  ocpUrl: "",

  provider: "ocp",
  model: "code-davinci-002",
  maxTokens: 60,
  temperature: 1,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  n: 5,

  showSettings: false,
  showNodeBorders: false,
  showExport: false,
};

type Color = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;

interface Node {
  text: string;
  parentId: string | null;
  collapsed: boolean;
  unread: boolean;
  bookmarked: boolean;
  color: Color;
  lastVisited?: number;
}

interface NoteState {
  current: string;
  hoisted: string[];
  nodes: Record<string, Node>;
  generating: string | null;
}

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

  renderLoomViews() {
	const views = this.app.workspace.getLeavesOfType("loom").map((leaf) => leaf.view) as LoomView[];
	views.forEach((view) => view.render());
  }

  renderLoomSiblingsViews() {
	const views = this.app.workspace.getLeavesOfType("loom-siblings").map((leaf) => leaf.view) as LoomSiblingsView[];
	views.forEach((view) => view.render());
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

  initializeProviders() {
	this.openai = new OpenAIApi(new Configuration({ apiKey: this.settings.openaiApiKey }));

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

  newNode(text: string, parentId: string | null, unread: boolean = false): [string, Node] {
    const id = uuidv4();
	const node: Node = {
	  text,
	  parentId,
	  collapsed: false,
	  unread,
	  bookmarked: false,
	  color: null,
	};
	return [id, node];
  }

  apiKeySet() {
    if (["openai", "openai-chat"].includes(this.settings.provider)) return !!this.settings.openaiApiKey;
	if (["azure", "azure-chat"].includes(this.settings.provider)) return !!this.settings.azureApiKey;
	if (this.settings.provider === "cohere") return !!this.settings.cohereApiKey;
	if (this.settings.provider === "textsynth") return !!this.settings.textsynthApiKey;
	if (this.settings.provider === "ocp") return !!this.settings.ocpApiKey;
	throw new Error(`Unknown provider ${this.settings.provider}`);
  }

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.app.workspace.trigger("parse-style-settings")
    this.addSettingTab(new LoomSettingTab(this.app, this));

	this.initializeProviders();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Completing...");
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
            this.app.workspace.trigger("loom:delete", state.current);
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

    const getState = () => this.withFile((file) => this.state[file.path]);
    const getSettings = () => this.settings;

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
            const nodeLengths = ancestors.map((id) => [
              id,
              this.state[view.file.path].nodes[id].text.length,
            ]);
            plugin.state = { ...plugin.state, nodeLengths };
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
          const ancestors = this.family(id, this.state[file.path]).slice(0, -1);
          ancestors.forEach(
            (id) => (this.state[file.path].nodes[id].collapsed = false)
          );

		  // update the editor's text
          const cursor = this.editor.getCursor();
          const linesBefore = this.editor.getValue().split("\n");
          this.editor.setValue(this.fullText(id, this.state[file.path]));

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
      this.app.workspace.on("loom:set-color", (id: string, color: Color) =>
        this.wftsar((file) => (this.state[file.path].nodes[id].color = color))
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
          const parentId = this.breakAtPoint();
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
          this.app.workspace.trigger("loom:delete", id);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:delete", (id: string) =>
        this.wftsar((file) => {
		  const state = this.state[file.path];
		  if (!canDelete(state, id, false)) return;
		  const parentId = state.nodes[id].parentId;

		  // remove the node from the hoist stack
          this.state[file.path].hoisted = state.hoisted.filter((id_) => id_ !== id);

		  // add the node and its descendants to a list of nodes to delete

		  let deleted = [id];

		  const addChildren = (id: string) => {
			const children = Object.entries(state.nodes)
			  .filter(([, node]) => node.parentId === id)
			  .map(([id]) => id);
			deleted = deleted.concat(children);
			children.forEach(addChildren);
		  }
		  addChildren(id);

		  // if the current node will be deleted, switch to its next sibling or its closest ancestor
		  if (deleted.includes(state.current)) {
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
          for (const id of children)
            this.app.workspace.trigger("loom:delete", id);
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
          for (const id of siblings)
            this.app.workspace.trigger("loom:delete", id);
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

  initializeNoteState(file: TFile) {
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
      bookmarked: false,
      color: null,
    };
    this.state[file.path].current = id;

    this.thenSaveAndRender(() => {});
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

  async completeInner(prompt: string) {
    this.statusBarItem.style.display = "inline-flex";

    // remove a trailing space if there is one
    // store whether there was, so it can be added back post-completion
    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    // replace "\<" with "<", because obsidian tries to render html tags
	// and "\[" with "["
    prompt = prompt.replace(/\\</g, "<");
	prompt = prompt.replace(/\\\[/g, "[");

    // trim to last 8000 tokens, the maximum allowed by openai
    const bpe = tokenizer.encode(prompt).bpe;
    const tokens = bpe.slice(
      Math.max(0, bpe.length - (8000 - this.settings.maxTokens)),
      bpe.length
    );
    prompt = tokenizer.decode(tokens);

    // complete, or visually display an error and return if that fails
    let rawCompletions;
    try {
      if (this.settings.provider === "openai-chat") {
        rawCompletions = (
          await this.openai.createChatCompletion({
            model: this.settings.model,
            messages: [{ role: "assistant", content: prompt }],
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
			presence_penalty: this.settings.presencePenalty,
			frequency_penalty: this.settings.frequencyPenalty,
          })
        ).data.choices.map((choice) => choice.message?.content);
      } else if (this.settings.provider === "openai") {
        rawCompletions = (
          await this.openai.createCompletion({
            model: this.settings.model,
            prompt,
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
			presence_penalty: this.settings.presencePenalty,
			frequency_penalty: this.settings.frequencyPenalty,
          })
        ).data.choices.map((choice) => choice.text);
      } else if (this.settings.provider === "azure-chat") {
        rawCompletions = (
          await this.azure.createChatCompletion({
            model: this.settings.model,
            messages: [{ role: "assistant", content: prompt }],
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
			presence_penalty: this.settings.presencePenalty,
			frequency_penalty: this.settings.frequencyPenalty,
          })
        ).data.choices.map((choice) => choice.message?.content);
      } else if (this.settings.provider === "azure") {
        rawCompletions = (
          await this.azure.createCompletion({
            model: this.settings.model,
            prompt,
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
			presence_penalty: this.settings.presencePenalty,
			frequency_penalty: this.settings.frequencyPenalty,
          })
        ).data.choices.map((choice) => choice.text);
      }
    } catch (e) {
      if (e.response.status === 401)
        new Notice(
          "OpenAI API key is invalid. Please provide a valid key in the settings."
        );
      else if (e.response.status === 429)
        new Notice("OpenAI API rate limit exceeded.");
      else new Notice("Unknown API error: " + e.response.data.error.message);

      this.statusBarItem.style.display = "none";
      return;
    }

    if (this.settings.provider === "cohere") {
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
      if (response.statusCode !== 200) {
        new Notice(
          "Cohere API responded with status code " + response.statusCode
        );

        this.statusBarItem.style.display = "none";
        return;
      }
      rawCompletions = response.body.generations.map(
        (generation) => generation.text
      );
    } else if (this.settings.provider === "textsynth") {
      const response = await requestUrl({
        url: `https://api.textsynth.com/v1/engines/${this.settings.model}/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.settings.textsynthApiKey}`,
        },
        body: JSON.stringify({
          prompt,
          max_tokens: this.settings.maxTokens,
          n: this.settings.n,
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
		  presence_penalty: this.settings.presencePenalty,
		  frequency_penalty: this.settings.frequencyPenalty,
        }),
      });
      if (response.status !== 200) {
        new Notice(
          "TextSynth API responded with status code " + response.status
        );

        this.statusBarItem.style.display = "none";
        return;
      }
      if (this.settings.n === 1) rawCompletions = [response.json.text];
      else rawCompletions = response.json.text;
    } else if (this.settings.provider === "ocp") {
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
        body: JSON.stringify({
          prompt,
          max_tokens: this.settings.maxTokens,
          n: this.settings.n,
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
		  presence_penalty: this.settings.presencePenalty,
		  frequency_penalty: this.settings.frequencyPenalty,
        }),
      });
      if (response.status !== 200) {
        new Notice("OCP API responded with status code " + response.status);

        this.statusBarItem.style.display = "none";
        return;
      }
      rawCompletions = response.json.choices.map(
        (choice: any) => choice.text
      );
    }

    if (rawCompletions === undefined) {
      new Notice("Invalid provider: " + this.settings.provider);

      this.statusBarItem.style.display = "none";
      return;
    }

    let completions = [];
    for (let completion of rawCompletions) {
      if (!completion) completion = ""; // empty completions are null, apparently
      completion = completion.replace(/</g, "\\<"); // escape < for obsidian
	  completion = completion.replace(/\[/g, "\\["); // escape [ for obsidian

      if (["azure-chat", "openai-chat"].includes(this.settings.provider))  {
        if (!trailingSpace) completion = " " + completion;
      } else if (trailingSpace && completion[0] === " ")
        completion = completion.slice(1);
	
	  completions.push(completion);
	}

	this.statusBarItem.style.display = "none";
	return completions;
  }

  async complete(file: TFile) {
	const state = this.state[file.path];
	this.breakAtPoint();
	await this.generate(file, state.current);
  }

  async generateSiblings(file: TFile) {
	const state = this.state[file.path];
	await this.generate(file, state.nodes[state.current].parentId);
  }

  async generate(file: TFile, rootNode: string | null) {
    const state = this.state[file.path];

	if (rootNode !== null) {
      this.app.workspace.trigger("loom:switch-to", rootNode);
      this.state[file.path].generating = rootNode;
	}

    this.saveAndRender();

    let prompt = `<|endoftext|>${this.fullText(rootNode, state)}`;

	const completions = await this.completeInner(prompt);
	if (!completions) return;

    // create a child node to the current node for each completion
    let ids = [];
    for (let completion of completions) {
      const id = uuidv4();
      state.nodes[id] = {
        text: completion,
        parentId: state.generating,
        unread: true,
        collapsed: false,
        bookmarked: false,
        color: null,
      };
      ids.push(id);
    }

    // switch to the first completion
    this.app.workspace.trigger("loom:switch-to", ids[0]);

    this.state[file.path].generating = null;
    this.saveAndRender();

    this.statusBarItem.style.display = "none";
  }

  fullText(id: string | null, state: NoteState) {
    let text = "";

    let current = id;
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

  breakAtPoint(): string | null | undefined {
    return this.withFile((file) => {
      // split the current node into:
      //   - parent node with text before cursor
      //   - child node with text after cursor

      const current = this.state[file.path].current;
      const cursor = this.editor.getCursor();

      // first, get the cursor's position in the full text
      let cursorPos = 0;
      for (let i = 0; i < cursor.line; i++)
        cursorPos += this.editor.getLine(i).length + 1;
      cursorPos += cursor.ch;

      const family = this.family(current, this.state[file.path]);
      const familyTexts = family.map(
        (id) => this.state[file.path].nodes[id].text
      );

      // find the node that the cursor is in
      let end = false;
      let i = cursorPos;
      let n = 0;
      while (true) {
        if (i < familyTexts[n].length) break;
        if (n === family.length - 1) {
          end = true;
          break;
        }
        i -= familyTexts[n].length;
        n++;
      }

      // if cursor is at the beginning of the node, create a sibling
      if (i === 0) {
        return null;
        // if cursor is at the end of the node, create a child
      } else if (end) {
        return current;
      }

      const inRangeNode = family[n];
      const inRangeNodeText = familyTexts[n];
      const currentCursorPos = i;

      // then, get the text before and after the cursor
      const before = inRangeNodeText.substring(0, currentCursorPos);
      const after = inRangeNodeText.substring(currentCursorPos);

      // then, set the in-range node's text to the text before the cursor
      this.state[file.path].nodes[inRangeNode].text = before;

      // get the in-range node's children, which will be moved later
      const children = Object.values(this.state[file.path].nodes).filter(
        (node) => node.parentId === inRangeNode
      );

      // then, create a new node with the text after the cursor
      const afterId = uuidv4();
      this.state[file.path].nodes[afterId] = {
        text: after,
        parentId: inRangeNode,
        unread: false,
        collapsed: false,
        bookmarked: false,
        color: null,
      };

      // move the children to under the after node
      children.forEach((child) => (child.parentId = afterId));

      return inRangeNode;
    });
  }

  canvasBreakAtPoint(): boolean {
	const view = this.app.workspace.getActiveViewOfType(ItemView);
	if (!view) return false;
	// @ts-expect-error
	const canvas = view.canvas;

	canvas.selection.forEach((node: any) => {
	  if (!node.isEditing) return;

      const editor = node.child.editor;
	  const text = editor.getValue();
	  const lines = text.split("\n");
	  const cursor = editor.getCursor();

      const before = [...lines.slice(0, cursor.line), lines[cursor.line].slice(0, cursor.ch)].join("\n");
      const after = text.slice(before.length);

	  editor.setValue(before);
	  editor.setCursor({line: cursor.line, ch: cursor.ch - 1});

	  this.canvasCreateChildNode(canvas, node, after);
	});

	return true;
  }

  async canvasCreateChildNode(canvas: any, node: any, childText: string) {
    const childNode = canvas.createTextNode({
	  pos: { x: node.x + node.width + 50, y: node.y },
	  size: { width: 300, height: 100 },
	  text: childText,
	  save: true,
	  focus: false,
	});

	const data = canvas.getData();
	canvas.importData({
	  edges: [...data.edges, { id: uuidv4(), fromNode: node.id, fromSide: "right", toNode: childNode.id, toSide: "left" }],
	  nodes: data.nodes,
	});
	canvas.requestFrame();

	await new Promise(r => setTimeout(r, 50)); // wait for the element to render

	const element = childNode.nodeEl;
	const sizer = element.querySelector(".markdown-preview-sizer");
	const height = sizer.getBoundingClientRect().height;

	const data_ = canvas.getData();
	canvas.importData({
	  edges: data_.edges,
	  nodes: data_.nodes.map((node: any) => {
		if (node.id === childNode.id) node.height = height / canvas.scale + 52;
		return node;
	  }
	)});
	canvas.requestFrame();

	return childNode;
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

class LoomView extends ItemView {
  getNoteState: () => NoteState | "canvas" | null;
  getSettings: () => LoomSettings;

  constructor(
    leaf: WorkspaceLeaf,
    getNoteState: () => NoteState | "canvas" | null,
    getSettings: () => LoomSettings
  ) {
    super(leaf);

    this.getNoteState = getNoteState;
    this.getSettings = getSettings;
    this.render();
  }

  render() {
    const state = this.getNoteState();
    const settings = this.getSettings();

    // get scroll position, which will be restored at the end
    const scroll = this.containerEl.scrollTop;

    this.containerEl.empty();
    this.containerEl.addClass("loom");

    // "nav buttons", or the toggles at the top of the pane

    const navButtonsContainer = this.containerEl.createDiv({
      cls: "nav-buttons-container loom-buttons",
    });

    const settingNavButton = (
      setting: string,
      value: boolean,
      icon: string,
      label: string
    ) => {
      const button = navButtonsContainer.createDiv({
        cls: `clickable-icon nav-action-button${value ? " is-active" : ""}`,
        attr: { "aria-label": label },
      });
      setIcon(button, icon);
      button.addEventListener("click", () =>
        this.app.workspace.trigger("loom:set-setting", setting, !value)
      );
    };

    settingNavButton(
      "showSettings",
      settings.showSettings,
      "settings",
      "Show settings"
    );
    settingNavButton(
      "showNodeBorders",
      settings.showNodeBorders,
      "separator-vertical",
      "Show node borders in the editor"
    );

	if (state !== "canvas") {
      const importFileInput = navButtonsContainer.createEl("input", {
        cls: "hidden",
        attr: { type: "file", id: "loom-import" },
      });
      const importNavButton = navButtonsContainer.createEl("label", {
        cls: "clickable-icon nav-action-button",
        attr: { "aria-label": "Import JSON", for: "loom-import" },
      });
      setIcon(importNavButton, "import");
      importFileInput.addEventListener("change", () => {
        // @ts-expect-error
	    const pathName = importFileInput.files[0].path;
        if (pathName) this.app.workspace.trigger("loom:import", pathName);
	  });

      const exportNavButton = navButtonsContainer.createDiv({
        cls: `clickable-icon nav-action-button${
          settings.showExport ? " is-active" : ""
        }`,
        attr: { "aria-label": "Export to JSON" },
      });
      setIcon(exportNavButton, "download");
      exportNavButton.addEventListener("click", (e) => {
        if (e.shiftKey)
          this.app.workspace.trigger(
            "loom:set-setting",
            "showExport",
            !settings.showExport
          );
        else
          dialog
            .showSaveDialog({
              title: "Export to JSON",
              filters: [{ extensions: ["json"] }],
            })
            .then((result: any) => {
              if (result && result.filePath)
                this.app.workspace.trigger("loom:export", result.filePath);
            });
      });
	}

    // create the main container, which uses the `outline` class, which has
    // a margin visually consistent with other panes
    const container = this.containerEl.createDiv({ cls: "outline" });

    // alternative export
    // (celeste uses this because a bug in obsidian breaks save dialogs for it)

    const exportDiv = container.createDiv({
      cls: `loom-zport${settings.showExport ? "" : " hidden"}`,
    });

    const exportInput = exportDiv.createEl("input", {
      attr: { type: "text", placeholder: "Path to export to" },
    });
    const exportButton = exportDiv.createEl("button", {});
    setIcon(exportButton, "download");
    exportButton.addEventListener("click", () => {
      if (exportInput.value) this.app.workspace.trigger("loom:export", exportInput.value)
	});

    container.createDiv({
      cls: `loom-vspacer${settings.showExport ? "" : " hidden"}`,
    });

    // settings

    const settingsDiv = container.createDiv({
      cls: `loom-settings${settings.showSettings ? "" : " hidden"}`,
    });

    const setting = (
      label: string,
      id: string,
      name: string,
      value: string,
      type: "text" | "number",
      parse: (value: string) => any
    ) => {
      const settingDiv = settingsDiv.createDiv({ cls: "loom-setting" });
      settingDiv.createEl("label", { text: label });
      const input = settingDiv.createEl("input", {
        type,
        value,
        attr: { id },
      });
      input.addEventListener("blur", () =>
        this.app.workspace.trigger("loom:set-setting", name, parse(input.value))
      );
    };

    const providerDiv = settingsDiv.createDiv({ cls: "loom-setting" });
    providerDiv.createEl("label", { text: "Provider" });
    const providerSelect = providerDiv.createEl("select", {
      attr: { id: "loom-provider" },
    });
    const providerOptions = [
      { name: "Cohere", value: "cohere" },
      { name: "TextSynth", value: "textsynth" },
      { name: "OpenAI code-davinci-002 proxy", value: "ocp" },
      { name: "OpenAI (Completion)", value: "openai" },
      { name: "OpenAI (Chat)", value: "openai-chat" },
      { name: "Azure (Completion)", value: "azure" },
      { name: "Azure (Chat)", value: "azure-chat" },
    ];
    providerOptions.forEach((option) => {
      const optionEl = providerSelect.createEl("option", {
        text: option.name,
        attr: { value: option.value },
      });
      if (option.value === settings.provider) {
        optionEl.setAttribute("selected", "selected");
      }
    });
    providerSelect.addEventListener("change", () =>
      this.app.workspace.trigger(
        "loom:set-setting",
        "provider",
        providerSelect.value
      )
    );
    setting(
      "Model",
      "loom-model",
      "model",
      settings.model,
      "text",
      (value) => value
    );
    setting(
      "Length (in tokens)",
      "loom-max-tokens",
      "maxTokens",
      String(settings.maxTokens),
      "number",
      (value) => parseInt(value)
    );
    setting(
      "Temperature",
      "loom-temperature",
      "temperature",
      String(settings.temperature),
      "number",
      (value) => parseFloat(value)
    );
    setting(
      "Top p",
      "loom-top-p",
      "topP",
      String(settings.topP),
      "number",
      (value) => parseFloat(value)
    );
	setting(
	  "Frequency penalty",
	  "loom-frequency-penalty",
	  "frequencyPenalty",
	  String(settings.frequencyPenalty),
	  "number",
	  (value) => parseFloat(value)
	);
	setting(
	  "Presence penalty",
	  "loom-presence-penalty",
	  "presencePenalty",
	  String(settings.presencePenalty),
	  "number",
	  (value) => parseFloat(value)
	);
    setting(
      "Number of completions",
      "loom-n",
      "n",
      String(settings.n),
      "number",
      (value) => parseInt(value)
    );

    // tree

    if (!state) {
      container.createEl("div", {
        cls: "pane-empty",
        text: "No note selected.",
      });
      return;
    }
	if (state === "canvas") {
	  container.createEl("div", {
		cls: "pane-empty",
		text: "The selected note is a canvas.",
	  });
	  return;
	}

    const nodes = Object.entries(state.nodes);

    // if there is one root node, mark it so it won't have a delete button
    let onlyRootNode: string | null = null;
    const rootNodes = nodes.filter(([, node]) => node.parentId === null);
    if (rootNodes.length === 1) onlyRootNode = rootNodes[0][0];

    const renderNode = (
      node: Node,
      id: string,
      container: HTMLElement,
      main: boolean
    ) => {
      // div for the node and its children
      const nodeDiv = container.createDiv({});

      // div for the node itself
      const itemDiv = nodeDiv.createDiv({
        cls: `is-clickable outgoing-link-item tree-item-self loom-node${
          node.unread ? " loom-node-unread" : ""
        }${id === state.current ? " is-active" : ""}${
          node.color ? ` loom-node-${node.color}` : ""
        }`,
        attr: main ? { id: `loom-node-${id}` } : {},
      });

      // an expand/collapse button if the node has children
      const hasChildren =
        nodes.filter(([, node]) => node.parentId === id).length > 0;
      if (main && hasChildren) {
        const collapseDiv = itemDiv.createDiv({
          cls: `collapse-icon loom-collapse${
            node.collapsed ? " is-collapsed" : ""
          }`,
        });
        setIcon(collapseDiv, "right-triangle");
        collapseDiv.addEventListener("click", () =>
          this.app.workspace.trigger("loom:toggle-collapse", id)
        );
      }

      // a bookmark icon if the node is bookmarked
      if (node.bookmarked) {
        const bookmarkDiv = itemDiv.createDiv({ cls: "loom-node-bookmark" });
        setIcon(bookmarkDiv, "bookmark");
      }

      // an unread indicator if the node is unread
      if (node.unread) itemDiv.createDiv({ cls: "loom-node-unread-indicator" });

      // the node's text
      const nodeText = itemDiv.createEl(node.text.trim() ? "span" : "em", {
        cls: "loom-node-inner tree-item-inner",
        text: node.text.trim() || "No text",
      });
      nodeText.addEventListener("click", () =>
        this.app.workspace.trigger("loom:switch-to", id)
      );

      // buttons on hover

      const iconsDiv = itemDiv.createDiv({ cls: "loom-icons" });
      itemDiv.createDiv({ cls: "loom-spacer" });

      const itemButton = (
        label: string,
        icon: string,
        callback: () => void
      ) => {
        const button = iconsDiv.createDiv({
          cls: "loom-icon",
          attr: { "aria-label": label },
        });
        setIcon(button, icon);
        button.addEventListener("click", callback);
      };

      const showMenu = () => {
        const menu = new Menu();

        menu.addItem((item) => {
          if (state.hoisted[state.hoisted.length - 1] === id) {
            item.setTitle("Unhoist");
            item.setIcon("arrow-down");
            item.onClick(() => this.app.workspace.trigger("loom:unhoist"));
          } else {
            item.setTitle("Hoist");
            item.setIcon("arrow-up");
            item.onClick(() => this.app.workspace.trigger("loom:hoist", id));
          }
        });
        menu.addItem((item) => {
          if (state.nodes[id].bookmarked) {
            item.setTitle("Remove bookmark");
            item.setIcon("bookmark-minus");
          } else {
            item.setTitle("Bookmark");
            item.setIcon("bookmark");
          }
          item.onClick(() =>
            this.app.workspace.trigger("loom:toggle-bookmark", id)
          );
        });
        menu.addItem((item) => {
          item.setTitle("Set color to...");
          item.setIcon("paint-bucket");
          item.onClick(() => {
            const colorMenu = new Menu();

            const colors = [
              { title: "Red", color: "red", icon: "paint-bucket" },
              { title: "Orange", color: "orange", icon: "paint-bucket" },
              { title: "Yellow", color: "yellow", icon: "paint-bucket" },
              { title: "Green", color: "green", icon: "paint-bucket" },
              { title: "Blue", color: "blue", icon: "paint-bucket" },
              { title: "Purple", color: "purple", icon: "paint-bucket" },
              { title: "Clear color", color: null, icon: "x" },
            ];
            for (const { title, color, icon } of colors) {
              colorMenu.addItem((item) => {
                item.setTitle(title);
                item.setIcon(icon);
                item.onClick(() =>
                  this.app.workspace.trigger("loom:set-color", id, color)
                );
              });
            }

            const rect = itemDiv.getBoundingClientRect();
            colorMenu.showAtPosition({ x: rect.right, y: rect.top });
          });
        });

        menu.addSeparator();

        menu.addItem((item) => {
          item.setTitle("Create child");
          item.setIcon("plus");
          item.onClick(() =>
            this.app.workspace.trigger("loom:create-child", id)
          );
        });
        menu.addItem((item) => {
          item.setTitle("Create sibling");
          item.setIcon("list-plus");
          item.onClick(() =>
            this.app.workspace.trigger("loom:create-sibling", id)
          );
        });

        menu.addSeparator();

        menu.addItem((item) => {
          item.setTitle("Delete all children");
          item.setIcon("x");
          item.onClick(() =>
            this.app.workspace.trigger("loom:clear-children", id)
          );
        });
        menu.addItem((item) => {
          item.setTitle("Delete all siblings");
          item.setIcon("list-x");
          item.onClick(() =>
            this.app.workspace.trigger("loom:clear-siblings", id)
          );
        });

        if (node.parentId) {
          menu.addSeparator();

          menu.addItem((item) => {
            item.setTitle("Merge with parent");
            item.setIcon("arrow-up-left");
            item.onClick(() =>
              this.app.workspace.trigger("loom:merge-with-parent", id)
            );
          });
        }

        if (id !== onlyRootNode) {
          menu.addSeparator();

          menu.addItem((item) => {
            item.setTitle("Delete");
            item.setIcon("trash");
            item.onClick(() => this.app.workspace.trigger("loom:delete", id));
          });
        }

        const rect = itemDiv.getBoundingClientRect();
        menu.showAtPosition({ x: rect.right, y: rect.top });
      };

      itemDiv.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMenu();
      });
      itemButton("Show menu", "menu", showMenu);

      if (state.hoisted[state.hoisted.length - 1] === id)
        itemButton("Unhoist", "arrow-down", () =>
          this.app.workspace.trigger("loom:unhoist")
        );
      else
        itemButton("Hoist", "arrow-up", () =>
          this.app.workspace.trigger("loom:hoist", id)
        );

      if (state.nodes[id].bookmarked)
        itemButton("Remove bookmark", "bookmark-minus", () =>
          this.app.workspace.trigger("loom:toggle-bookmark", id)
        );
      else
        itemButton("Bookmark", "bookmark", () =>
          this.app.workspace.trigger("loom:toggle-bookmark", id)
        );

      if (id !== onlyRootNode)
        itemButton("Delete", "trash", () =>
          this.app.workspace.trigger("loom:delete", id)
        );

      // indicate if the node is generating children
      if (state.generating === id && main) {
        const generatingDiv = nodeDiv.createDiv({ cls: "loom-node-footer" });
        const generatingIcon = generatingDiv.createDiv({ cls: "rotating" });
        setIcon(generatingIcon, "loader-2");
        generatingDiv.createEl("span", {
          cls: "loom-node-footer-text",
          text: "Generating...",
        });
      }

      // render children if the node is not collapsed
      if (main && !node.collapsed) {
        const hasChildren =
          nodes.filter(([, node]) => node.parentId === id).length > 0;
        if (nodeDiv.offsetWidth < 150 && hasChildren) {
          const hoistButton = nodeDiv.createDiv({
            cls: "loom-node-footer loom-hoist-button",
          });
          setIcon(hoistButton, "arrow-up");
          hoistButton.createEl("span", {
            text: "Show more...",
            cls: "loom-node-footer-text",
          });

          hoistButton.addEventListener("click", () =>
            this.app.workspace.trigger("loom:hoist", id)
          );
        } else {
          const childrenDiv = nodeDiv.createDiv({ cls: "loom-children" });
          renderChildren(id, childrenDiv);
        }
      }
    };

    const renderChildren = (
      parentId: string | null,
      container: HTMLElement
    ) => {
      const children = nodes.filter(([, node]) => node.parentId === parentId);
      for (const [id, node] of children) renderNode(node, id, container, true);
    };

    // bookmark list
    const bookmarksDiv = container.createDiv({ cls: "loom-section" });
    const bookmarks = nodes.filter(([, node]) => node.bookmarked);
    const bookmarkHeader = bookmarksDiv.createDiv({
      cls: "tree-item-self loom-node loom-section-header",
    });
    bookmarkHeader.createEl("span", {
      text: "Bookmarks",
      cls: "tree-item-inner loom-section-header-inner",
    });
    bookmarkHeader.createEl("span", {
      text: `${bookmarks.length}`,
      cls: "tree-item-flair-outer loom-section-count",
    });
    for (const [id, node] of bookmarks)
      renderNode(node, id, bookmarksDiv, false);

    // main tree header
    const treeHeader = container.createDiv({
      cls: "tree-item-self loom-node loom-section-header",
    });
    const treeHeaderText =
      state.hoisted.length > 0 ? "Hoisted node" : "All nodes";
    treeHeader.createEl("span", {
      text: treeHeaderText,
      cls: "tree-item-inner loom-section-header-inner",
    });

    // if there is a hoisted node, it is the root node
    // otherwise, all children of `null` are the root nodes
    if (state.hoisted.length > 0)
      renderNode(
        state.nodes[state.hoisted[state.hoisted.length - 1]],
        state.hoisted[state.hoisted.length - 1],
        container,
        true
      );
    else renderChildren(null, container);

    // restore scroll position
    this.containerEl.scrollTop = scroll;

    // scroll to current node if it is not visible
    const current = document.getElementById(`loom-node-${state.current}`);
    if (current) {
      const rect = current.getBoundingClientRect();
      if (rect.top < 25 || rect.bottom > this.containerEl.clientHeight)
        current.scrollIntoView();
    }
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

class LoomSiblingsView extends ItemView {
  getNoteState: () => NoteState | "canvas" | null;

  constructor(leaf: WorkspaceLeaf, getNoteState: () => NoteState | "canvas" | null) {
    super(leaf);
    this.getNoteState = getNoteState;
    this.render();
  }

  render() {
    const scroll = this.containerEl.scrollTop;

    this.containerEl.empty();
    this.containerEl.addClass("loom");
    const outline = this.containerEl.createDiv({ cls: "outline" });

    const state = this.getNoteState();

    if (!state) {
      outline.createEl("div", {
        text: "No note selected.",
        cls: "pane-empty",
      });
      return;
    }
	if (state === "canvas") {
	  outline.createEl("div", {
		text: "The selected note is a canvas.",
		cls: "pane-empty",
	  });
	  return;
	}

    const parentId = state.nodes[state.current].parentId;
    const siblings = Object.entries(state.nodes).filter(
      ([, node]) => node.parentId === parentId
    );

    let currentDiv;
    for (const i in siblings) {
      const [id, node] = siblings[i];

      const siblingDiv = outline.createEl("div", {
        cls: `loom-sibling${id === state.current ? " is-active" : ""}`,
      });
      if (parentId !== null)
        siblingDiv.createEl("span", {
          text: "…",
          cls: "loom-sibling-ellipsis",
        });
      siblingDiv.createEl("span", { text: node.text.trim() });
      siblingDiv.addEventListener("click", () =>
        this.app.workspace.trigger("loom:switch-to", id)
      );

      if (parseInt(i) !== siblings.length - 1)
        outline.createEl("hr", { cls: "loom-sibling-divider" });

      if (id === state.current) currentDiv = siblingDiv;
    }

    this.containerEl.scrollTop = scroll;

    if (currentDiv) {
      const rect = currentDiv.getBoundingClientRect();
      if (rect.top < 25 || rect.bottom > this.containerEl.clientHeight)
        currentDiv.scrollIntoView();
    }
  }

  getViewType(): string {
    return "loom-siblings";
  }

  getDisplayText(): string {
    return "Siblings";
  }

  getIcon(): string {
    return "layout-list";
  }
}

interface LoomEditorPluginState {
  ancestorLengths: [string, number][];
  showNodeBorders: boolean;
}

class LoomEditorPlugin implements PluginValue {
  decorations: DecorationSet;
  state: LoomEditorPluginState;
  view: EditorView;

  constructor(view: EditorView) {
    this.decorations = Decoration.none;
    this.state = { ancestorLengths: [], showNodeBorders: false };
    this.view = view;
  }

  update(_update: ViewUpdate) {
    let decorations: Range<Decoration>[] = [];

    const pushNewRange = (start: number, end: number, id: string) => {
      try {
        const range = Decoration.mark({
          class: `loom-bct loom-bct-${id}`,
        }).range(start, end);
        decorations.push(range);
      } catch (e) {
        /* errors if the range is empty, just ignore */
      }
    };

    let i = 0;
    for (const [id, length] of this.state.ancestorLengths) {
      pushNewRange(i, i + length, id);
      i += length;

      if (this.state.showNodeBorders) {
        const decoration = Decoration.widget({
          widget: new LoomBorderWidget(),
          side: -1,
        }).range(i, i);
        decorations.push(decoration);
      }
    }

    this.decorations = Decoration.set(decorations);
  }
}

const loomEditorPluginSpec: PluginSpec<LoomEditorPlugin> = {
  decorations: (plugin: LoomEditorPlugin) => plugin.decorations,
  eventHandlers: {
    mouseover: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom-bct")) return false;

      const className = target.classList[target.classList.length - 1];
      for (const el of [].slice.call(
        document.getElementsByClassName(className)
      ))
        el.classList.add("loom-bct-hover");

      return true;
    },
    mouseout: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom-bct")) return false;

      const className = target.classList[target.classList.length - 1];
      for (const el of [].slice.call(
        document.getElementsByClassName(className)
      ))
        el.classList.remove("loom-bct-hover");

      return true;
    },
    mousedown: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0 || !event.shiftKey) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom-bct")) return false;

      // the second last element, since the last is `loom-bct-hover`
      const className = target.classList[target.classList.length - 2];
      const id = className.split("-").slice(2).join("-");
      app.workspace.trigger("loom:switch-to", id);

      return true;
    },
  },
};

class LoomBorderWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.classList.add("loom-bct-border");
    return el;
  }

  eq() {
    return true;
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

    new Setting(containerEl).setName("Provider").addDropdown((dropdown) => {
      dropdown.addOption("cohere", "Cohere");
      dropdown.addOption("textsynth", "TextSynth");
      dropdown.addOption("ocp", "OpenAI code-davinci-002 proxy");
      dropdown.addOption("openai", "OpenAI (Completion)");
      dropdown.addOption("openai-chat", "OpenAI (Chat)");
      dropdown.addOption("azure", "Azure (Completion)");
      dropdown.addOption("azure-chat", "Azure (Chat)");
      dropdown.setValue(this.plugin.settings.provider);
      dropdown.onChange(async (value) => {
        if (PROVIDERS.find((provider) => provider === value))
          this.plugin.settings.provider = value;
        await this.plugin.save();
      });
    });

    const apiKeySetting = (name: string, setting: LoomSettingKey) => {
      new Setting(containerEl)
        .setName(`${name} API key`)
        .setDesc(`Required if using ${name}`)
        .addText((text) =>
          text
            .setValue(this.plugin.settings[setting])
            .onChange(async (value) => {
              this.plugin.settings[setting] = value;
              await this.plugin.save();
            })
        );
    };

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
    apiKeySetting("Azure", "azureApiKey")

    new Setting(containerEl)
        .setName("Azure resource endpoint")
        .setDesc("Required if using Azure")
        .addText((text) =>
            text.setValue(this.plugin.settings.azureEndpoint).onChange(async (value) => {
              this.plugin.settings.azureEndpoint = value;
              await this.plugin.save();
            })
        );
          

    // TODO: reduce duplication of other settings

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

    new Setting(containerEl).setName("Top p").addText((text) =>
      text
        .setValue(this.plugin.settings.topP.toString())
        .onChange(async (value) => {
          this.plugin.settings.topP = parseFloat(value);
          await this.plugin.save();
        })
    );

	new Setting(containerEl).setName("Frequency penalty").addText((text) =>
	  text
		.setValue(this.plugin.settings.frequencyPenalty.toString())
		.onChange(async (value) => {
		  this.plugin.settings.frequencyPenalty = parseFloat(value);
		  await this.plugin.save();
		})
	);

	new Setting(containerEl).setName("Presence penalty").addText((text) =>
	  text
		.setValue(this.plugin.settings.presencePenalty.toString())
		.onChange(async (value) => {
		  this.plugin.settings.presencePenalty = parseFloat(value);
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
