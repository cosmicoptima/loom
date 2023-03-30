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
} from "@codemirror/view";
import * as cohere from "cohere-ai";
import * as fs from "fs";
import GPT3Tokenizer from "gpt3-tokenizer";
import { Configuration, OpenAIApi } from "openai";
import { v4 as uuidv4 } from "uuid";
const dialog = require("electron").remote.dialog;
const untildify = require("untildify") as any;

const tokenizer = new GPT3Tokenizer({ type: "codex" });

const PROVIDERS = ["cohere", "textsynth", "ocp", "openai", "openai-chat"];
type Provider = (typeof PROVIDERS)[number];

interface LoomSettings {
  openaiApiKey: string;
  cohereApiKey: string;
  textsynthApiKey: string;

  ocpApiKey: string;
  ocpUrl: string;

  provider: Provider;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  n: number;

  showSettings: boolean;
  cloneParentOnEdit: boolean;
  showExport: boolean;
}

type LSStringProperty = keyof {
  [K in keyof LoomSettings as LoomSettings[K] extends string
    ? K
    : never]: LoomSettings[K];
};

const DEFAULT_SETTINGS: LoomSettings = {
  openaiApiKey: "",
  cohereApiKey: "",
  textsynthApiKey: "",

  ocpApiKey: "",
  ocpUrl: "",

  provider: "cohere",
  model: "xlarge",
  maxTokens: 60,
  temperature: 1,
  topP: 1,
  n: 5,

  showSettings: false,
  cloneParentOnEdit: false,
  showExport: false,
};

type Color = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;

interface Node {
  text: string;
  parentId: string | null;
  unread: boolean;
  lastVisited?: number;
  collapsed: boolean;
  bookmarked: boolean;
  color: Color;
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
  // view: LoomView;
  statusBarItem: HTMLElement;

  openai: OpenAIApi;

  view(): LoomView {
    return this.app.workspace.getLeavesOfType("loom").map((leaf) => leaf.view)[0] as LoomView;
  }

  withFile<T>(callback: (file: TFile) => T): T | null {
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    return callback(file);
  }

  thenSaveAndRender(callback: () => void) {
    callback();

    this.save();
    this.view().render();
  }

  wftsar(callback: (file: TFile) => void) {
    this.thenSaveAndRender(() => {
      this.withFile(callback);
    });
  }

  setOpenAI() {
    const configuration = new Configuration({
      apiKey: this.settings.openaiApiKey,
    });
    this.openai = new OpenAIApi(configuration);
  }

  setCohere() {
    cohere.init(this.settings.cohereApiKey);
  }

  async onload() {
    await this.loadSettings();
    await this.loadState();

    this.addSettingTab(new LoomSettingTab(this.app, this));

    this.setOpenAI();
    this.setCohere();

    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("Completing...");
    this.statusBarItem.style.display = "none";

    this.addCommand({
      id: "loom-complete",
      name: "Complete from current point",
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

    const openLoomPane = () => {
      const loomPanes = this.app.workspace.getLeavesOfType("loom");
      try {
        if (loomPanes.length === 0)
          this.app.workspace.getRightLeaf(false).setViewState({ type: "loom" });
        else this.app.workspace.revealLeaf(loomPanes[0]);
      } catch (e) {
        console.error(e);
      }
    };

    this.addCommand({
      id: "loom-create-child",
      name: "Create child of current node",
      icon: "plus",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:create-child", state.current)
        ),
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "n" }],
    });

    this.addCommand({
      id: "loom-create-sibling",
      name: "Create sibling of current node",
      icon: "list-plus",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:create-sibling", state.current)
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "n" }],
    });

    this.addCommand({
      id: "loom-clone-current-node",
      name: "Clone current node",
      icon: "copy",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:clone", state.current)
        ),
      hotkeys: [{ modifiers: ["Ctrl", "Alt"], key: "c" }],
    });

    this.addCommand({
      id: "loom-break-at-point",
      name: "Branch from current point",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:break-at-point", state.current)
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "c" }],
    });

    this.addCommand({
      id: "loom-merge-with-parent",
      name: "Merge current node with parent",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:merge-with-parent", state.current)
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "m" }]
    });

    this.addCommand({
      id: "loom-switch-to-next-sibling",
      name: "Switch to next sibling",
      icon: "arrow-down",
      callback: () =>
        withState((state) => {
          const nextSibling = this.nextSibling(state.current, state);
          if (nextSibling)
            this.app.workspace.trigger("loom:switch-to", nextSibling);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowDown" }],
    });

    this.addCommand({
      id: "loom-switch-to-previous-sibling",
      name: "Switch to previous sibling",
      icon: "arrow-up",
      callback: () =>
        withState((state) => {
          const prevSibling = this.prevSibling(state.current, state);
          if (prevSibling)
            this.app.workspace.trigger("loom:switch-to", prevSibling);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowUp" }],
    });

    this.addCommand({
      id: "loom-switch-to-parent",
      name: "Switch to parent",
      icon: "arrow-left",
      callback: () =>
        withState((state) => {
          const parentId = state.nodes[state.current].parentId;
          if (parentId) this.app.workspace.trigger("loom:switch-to", parentId);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowLeft" }],
    });

    this.addCommand({
      id: "loom-switch-to-child",
      name: "Switch to child",
      icon: "arrow-right",
      callback: () =>
        withState((state) => {
          const lastVisitedChild = this.lastVisitedChild(state);
          if (lastVisitedChild)
            this.app.workspace.trigger("loom:switch-to", lastVisitedChild);
        }),
      hotkeys: [{ modifiers: ["Alt"], key: "ArrowRight" }],
    });

    this.addCommand({
      id: "loom-delete-current-node",
      name: "Delete current node",
      icon: "trash",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:delete", state.current)
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "Backspace" }],
    });

    this.addCommand({
      id: "loom-clear-children",
      name: "Delete current node's children",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:clear-children", state.current)
        ),
    });

    this.addCommand({
      id: "loom-clear-siblings",
      name: "Delete current node's siblings",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:clear-siblings", state.current)
        ),
    });

    this.addCommand({
      id: "loom-toggle-collapse-current-node",
      name: "Toggle whether current node is collapsed",
      icon: "folder-up",
      callback: () =>
        withState((state) =>
          this.app.workspace.trigger("loom:toggle-collapse", state.current)
        ),
      hotkeys: [{ modifiers: ["Alt"], key: "e" }],
    });

    this.addCommand({
      id: "loom-open-pane",
      name: "Open Loom pane",
      callback: openLoomPane,
    });

    this.addCommand({
      id: "loom-debug-reset-state",
      name: "Debug: Reset state",
      callback: () => this.thenSaveAndRender(() => (this.state = {})),
    });

    const getState = () => this.withFile((file) => this.state[file.path]);
    const getSettings = () => this.settings;

    this.registerView(
      "loom",
      (leaf) => new LoomView(leaf, getState, getSettings)
    );

    const loomEditorPlugin = ViewPlugin.fromClass(
      LoomEditorPlugin,
      loomEditorPluginSpec
    );
    this.registerEditorExtension([loomEditorPlugin]);

    openLoomPane();

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, view: MarkdownView) => {
          // get cursor position, so it can be restored later
          const cursor = editor.getCursor();

          this.thenSaveAndRender(() => {
            // if this note has no state, initialize it
            if (!this.state[view.file.path])
              this.state[view.file.path] = {
                current: null as any, // `current` will be defined later
                hoisted: [] as string[],
                nodes: {},
                generating: null,
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
                bookmarked: false,
                color: null,
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
              const followingText = text.substring(newPrefix.length);

              const { children, newText } = (() => {
                for (let j = familyTexts.length - 1; j >= 0; j--) {
                  const suffix = familyTexts.slice(j).join("");
                  if (followingText.endsWith(suffix)) continue;

                  const lastSuffix = familyTexts.slice(j + 1).join("");
                  return {
                    children: j + 1,
                    newText: followingText.substring(
                      0,
                      followingText.length - lastSuffix.length
                    ),
                  };
                }

                throw new Error("unreachable"); // TODO
              })();

              const id = uuidv4();
              this.state[view.file.path].nodes[id] = {
                text: newText,
                parentId: i === 0 ? null : ancestors[i - 1],
                unread: false,
                collapsed: false,
                bookmarked: false,
                color: null,
              };

              let parentId = id;
              for (let j = children; j < familyTexts.length; j++) {
                const childId = uuidv4();
                this.state[view.file.path].nodes[childId] = {
                  text: familyTexts[j],
                  parentId,
                  unread: false,
                  collapsed: false,
                  bookmarked: false,
                  color: null,
                };
                parentId = childId;
              }

              this.app.workspace.trigger("loom:switch-to", parentId);
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
            if (
              children.length > 0 &&
              text !== fullText &&
              this.settings.cloneParentOnEdit
            ) {
              cloneParent(ancestors.length);
              return;
            }

            this.state[view.file.path].nodes[current].text = text.slice(
              ancestorTexts.join("").length
            );

            // @ts-expect-error
            const editorView = editor.cm;
            const plugin = editorView.plugin(loomEditorPlugin);
            const lines = ancestorTexts.join("").split("\n");
            plugin.state = {
              breakLine: lines.length,
              breakCh: lines.length > 0 ? lines[lines.length - 1].length : 0,
            };
            plugin.update();
          });

          // restore cursor position
          editor.setCursor(cursor);

          // update `LoomEditorPlugin`'s state with:
          //   - the text preceding the current node's text
          //   - the current node's text
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

          const ancestors = this.family(id, this.state[file.path]).slice(0, -1);
          ancestors.forEach(
            (id) => (this.state[file.path].nodes[id].collapsed = false)
          );

          const cursor = this.editor.getCursor();
          const linesBefore = this.editor.getValue().split("\n");

          this.editor.setValue(this.fullText(id, this.state[file.path]));

          const linesAfter = this.editor
            .getValue()
            .split("\n")
            .slice(0, cursor.line);
          let different = false;
          for (let i = 0; i < cursor.line; i++) {
            if (linesBefore[i] !== linesAfter[i]) {
              different = true;
              break;
            }
          }
          if (linesBefore[cursor.line] !== this.editor.getLine(cursor.line))
            different = true;

          if (different) {
            const line = this.editor.lineCount() - 1;
            const ch = this.editor.getLine(line).length;
            this.editor.setCursor({ line, ch });
          } else this.editor.setCursor(cursor);
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
          const newId = uuidv4();
          this.state[file.path].nodes[newId] = {
            text: "",
            parentId: id,
            unread: false,
            collapsed: false,
            bookmarked: false,
            color: null,
          };

          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:create-sibling", (id: string) =>
        this.withFile((file) => {
          const newId = uuidv4();
          this.state[file.path].nodes[newId] = {
            text: "",
            parentId: this.state[file.path].nodes[id].parentId,
            unread: false,
            collapsed: false,
            bookmarked: false,
            color: null,
          };

          this.app.workspace.trigger("loom:switch-to", newId);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clone", (id: string) =>
        this.withFile((file) => {
          const newId = uuidv4();
          this.state[file.path].nodes[newId] = {
            text: this.state[file.path].nodes[id].text,
            parentId: this.state[file.path].nodes[id].parentId,
            unread: false,
            collapsed: false,
            bookmarked: false,
            color: null,
          };

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
            const newId = uuidv4();
            this.state[file.path].nodes[newId] = {
              text: "",
              parentId,
              unread: false,
              collapsed: false,
              bookmarked: false,
              color: null,
            };
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
          const parentId = state.nodes[id].parentId;

          if (parentId === null) {
            new Notice("Can't merge a root node with its parent");
            return;
          }
          if (Object.values(state.nodes).filter((n) => n.parentId === parentId).length > 1) {
            new Notice("Can't merge this node with its parent; it has siblings");
            return;
          }

          state.nodes[parentId].text += state.nodes[id].text;
          this.app.workspace.trigger("loom:switch-to", parentId);
          this.app.workspace.trigger("loom:delete", id);
        }
      )
    ));

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:delete", (id: string) =>
        this.wftsar((file) => {
          const rootNodes = Object.entries(this.state[file.path].nodes)
            .filter(([, node]) => node.parentId === null)
            .map(([id]) => id);
          if (rootNodes.length === 1 && rootNodes[0] === id) {
            new Notice("The last root node can't be deleted");
            return;
          }

          this.state[file.path].hoisted = this.state[file.path].hoisted.filter(
            (id_) => id_ !== id
          );

          let fallback = this.nextSibling(id, this.state[file.path]);
          if (!fallback) fallback = this.state[file.path].nodes[id].parentId;

          let deleted = [id];

          const deleteChildren = (id: string) => {
            for (const [id_, node] of Object.entries(
              this.state[file.path].nodes
            ))
              if (node.parentId === id) {
                deleteChildren(id_);
                delete this.state[file.path].nodes[id_];
                deleted.push(id_);
              }
          };

          delete this.state[file.path].nodes[id];
          deleteChildren(id);

          if (deleted.includes(this.state[file.path].current))
            this.app.workspace.trigger("loom:switch-to", fallback);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-children", (id: string) =>
        this.wftsar((file) => {
          const children = Object.entries(this.state[file.path].nodes).filter(
            ([, node]) => node.parentId === id
          );
          for (const [id] of children)
            this.app.workspace.trigger("loom:delete", id);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:clear-siblings", (id: string) =>
        this.wftsar((file) => {
          const parentId = this.state[file.path].nodes[id].parentId;
          const siblings = Object.entries(this.state[file.path].nodes).filter(
            ([id_, node]) => node.parentId === parentId && id_ !== id
          );
          for (const [id] of siblings)
            this.app.workspace.trigger("loom:delete", id);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:set-setting", (setting: string, value: any) =>
        this.thenSaveAndRender(
          () => (this.settings = { ...this.settings, [setting]: value })
        )
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:import", (pathName: string) =>
        this.wftsar((file) => {
          if (!pathName) return;

          const rawPathName = untildify(pathName);
          const json = fs.readFileSync(rawPathName, "utf8");
          const data = JSON.parse(json);
          this.state[file.path] = data;
          new Notice("Imported from " + rawPathName);

          this.app.workspace.trigger("loom:switch-to", data.current);
        })
      )
    );

    this.registerEvent(
      // @ts-expect-error
      this.app.workspace.on("loom:export", (pathName: string) =>
        this.wftsar((file) => {
          if (!pathName) return;

          const data = this.state[file.path];
          const json = JSON.stringify(data, null, 2);
          const rawPathName = untildify(pathName);
          fs.writeFileSync(rawPathName, json);
          new Notice("Exported to " + rawPathName);
        })
      )
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;

        this.view().render();

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

        // @ts-expect-error
        const editorView = this.editor.cm;
        const plugin = editorView.plugin(loomEditorPlugin);

        const state = this.state[file.path];

        let ancestors: string[] = [];
        let node: string | null = state.current;
        while (node) {
          node = this.state[file.path].nodes[node].parentId;
          if (node) ancestors.push(node);
        }
        ancestors = ancestors.reverse();

        const ancestorTexts = ancestors.map((id) => state.nodes[id].text);

        const lines = ancestorTexts.join("").split("\n");
        plugin.state = {
          breakLine: lines.length - 1,
          breakCh: lines.length > 0 ? lines[lines.length - 1].length : 0,
        };
        plugin.update();
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
      this.app.workspace.on("resize", () => this.view().render())
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
      })
    );
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
      bookmarked: false,
      color: null,
    };
    this.state[file.path].current = id;

    this.thenSaveAndRender(() => {});
  }

  async complete() {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    // TODO add async support to withFile and wftsar, so `complete` can be wrapped

    this.statusBarItem.style.display = "inline-flex";

    const state = this.state[file.path];

    this.breakAtPoint();
    this.app.workspace.trigger("loom:switch-to", state.current);

    this.state[file.path].generating = state.current;
    this.save();
    this.view().render();

    let prompt = this.fullText(state.current, state);

    // remove a trailing space if there is one
    // store whether there was, so it can be added back post-completion
    const trailingSpace = prompt.match(/\s+$/);
    prompt = prompt.replace(/\s+$/, "");

    // replace "\<" with "<", because obsidian tries to render html tags
    prompt = prompt.replace(/\\</g, "<");

    // trim to last 8000 tokens, the maximum allowed by openai
    const bpe = tokenizer.encode(prompt).bpe;
    const tokens = bpe.slice(
      Math.max(0, bpe.length - (8000 - this.settings.maxTokens)),
      bpe.length
    );
    prompt = tokenizer.decode(tokens);

    // complete, or visually display an error and return if that fails
    let completions;
    try {
      if (this.settings.provider === "openai-chat") {
        completions = (
          await this.openai.createChatCompletion({
            model: this.settings.model,
            messages: [{ role: "assistant", content: prompt }],
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
          })
        ).data.choices.map((choice) => choice.message?.content);
      } else if (this.settings.provider === "openai") {
        completions = (
          await this.openai.createCompletion({
            model: this.settings.model,
            prompt,
            max_tokens: this.settings.maxTokens,
            n: this.settings.n,
            temperature: this.settings.temperature,
            top_p: this.settings.topP,
          })
        ).data.choices.map((choice) => choice.text);
      }
    } catch (e) {
      if (
        e.response.status === 401 &&
        ["openai", "openai-chat"].includes(this.settings.provider)
      )
        new Notice(
          "OpenAI API key is invalid. Please provide a valid key in the settings."
        );
      else if (
        e.response.status === 429 &&
        ["openai", "openai-chat"].includes(this.settings.provider)
      )
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
      });
      if (response.statusCode !== 200) {
        new Notice(
          "Cohere API responded with status code " + response.statusCode
        );

        this.statusBarItem.style.display = "none";
        return;
      }
      completions = response.body.generations.map(
        (generation) => generation.text
      );
    } else if (this.settings.provider === "textsynth") {
      // TextSynth API doesn't have CORS enabled, so we have to proxy
      const response = await fetch("https://celeste.exposed/api/textsynth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.settings.textsynthApiKey,
          model: this.settings.model,
          prompt,
          max_tokens: this.settings.maxTokens,
          n: this.settings.n,
          temperature: this.settings.temperature,
          top_p: this.settings.topP,
        }),
      });
      if (response.status !== 200) {
        new Notice(
          "TextSynth API responded with status code " + response.status
        );

        this.statusBarItem.style.display = "none";
        return;
      }
      if (this.settings.n === 1)
        completions = [(await response.json()).response.text];
      else completions = (await response.json()).response.text;
    } else if (this.settings.provider === "ocp") {
      let url = this.settings.ocpUrl;

      if (!(url.startsWith("http://") || url.startsWith("https://")))
        url = "https://" + url;
      if (!url.endsWith("/")) url += "/";
      url += "v1/completions";

      const response = await fetch(url, {
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
        }),
      });
      if (response.status !== 200) {
        new Notice("OCP API responded with status code " + response.status);

        this.statusBarItem.style.display = "none";
        return;
      }
      completions = (await response.json()).choices.map(
        (choice: any) => choice.text
      );
    }

    if (completions === undefined) {
      new Notice("Invalid provider: " + this.settings.provider);

      this.statusBarItem.style.display = "none";
      return;
    }

    // create a child node to the current node for each completion
    let ids = [];
    for (let completion of completions) {
      if (!completion) completion = ""; // empty completions are null, apparently
      completion = completion.replace(/</g, "\\<"); // escape < for obsidian

      if (this.settings.provider === "openai-chat") {
        if (!trailingSpace) completion = " " + completion;
      } else if (trailingSpace && completion[0] === " ")
        completion = completion.slice(1);

      const id = uuidv4();
      state.nodes[id] = {
        text: completion,
        parentId: state.current,
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
    this.save();
    this.view().render();

    this.statusBarItem.style.display = "none";
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

  async loadSettings() {
    const settings = (await this.loadData())?.settings || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
  }

  async loadState() {
    this.state = (await this.loadData())?.state || {};
  }

  async save() {
    await this.saveData({ settings: this.settings, state: this.state });
    this.setOpenAI();
    this.setCohere();
  }
}

class LoomView extends ItemView {
  getNoteState: () => NoteState | null;
  getSettings: () => LoomSettings;

  constructor(
    leaf: WorkspaceLeaf,
    getNoteState: () => NoteState | null,
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
    const scroll = (this.containerEl as HTMLElement).scrollTop;

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
      "cloneParentOnEdit",
      settings.cloneParentOnEdit,
      "copy",
      "Don't allow nodes with children to be edited; clone them instead"
    );

    const importFileInput = navButtonsContainer.createEl("input", {
      cls: "hidden",
      attr: { type: "file", id: "loom-import" },
    });
    const importNavButton = navButtonsContainer.createEl("label", {
      cls: "clickable-icon nav-action-button",
      attr: { "aria-label": "Import JSON", for: "loom-import" },
    });
    setIcon(importNavButton, "import");
    importFileInput.addEventListener("change", () =>
      // @ts-expect-error
      this.app.workspace.trigger("loom:import", importFileInput.files[0].path)
    );

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
            if (result)
              this.app.workspace.trigger("loom:export", result.filePath);
          });
    });

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
    exportButton.addEventListener("click", () =>
      this.app.workspace.trigger("loom:export", exportInput.value)
    );

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

    const nodes = Object.entries(state.nodes);

    // if there is one root node, mark it so it won't have a delete button
    let onlyRootNode: string | null = null;
    const rootNodes = nodes.filter(([, node]) => node.parentId === null);
    if (rootNodes.length === 1) onlyRootNode = rootNodes[0][0];

    const renderNode = (
      node: Node,
      id: string,
      container: HTMLElement,
      children: boolean
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
        attr: { id: `loom-node-${id}` },
      });

      // an expand/collapse button if the node has children
      const hasChildren =
        nodes.filter(([, node]) => node.parentId === id).length > 0;
      if (children && hasChildren) {
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
      const nodeText = itemDiv.createEl(node.text ? "span" : "em", {
        cls: "loom-node-inner tree-item-inner",
        text: node.text || "No text",
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
            item.onClick(() => this.app.workspace.trigger("loom:merge-with-parent", id));
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
      if (state.generating === id) {
        const generatingDiv = nodeDiv.createDiv({ cls: "loom-node-footer" });
        const generatingIcon = generatingDiv.createDiv({ cls: "rotating" });
        setIcon(generatingIcon, "loader-2");
        generatingDiv.createEl("span", {
          cls: "loom-node-footer-text",
          text: "Generating...",
        });
      }

      // render children if the node is not collapsed
      if (children && !node.collapsed) {
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

interface LoomEditorPluginState {
  breakLine: number;
  breakCh: number;
}

class LoomEditorPlugin implements PluginValue {
  decorations: DecorationSet;
  state: LoomEditorPluginState;
  view: EditorView;

  constructor(view: EditorView) {
    this.decorations = Decoration.none;
    this.state = { breakLine: 0, breakCh: 0 };
    this.view = view;
  }

  update(_update: ViewUpdate) {
    let decorations: Range<Decoration>[] = [];

    const pushNewRange = (start: number, end: number) => {
      try {
        const range = Decoration.mark({
          class: "loom-before-current-text",
        }).range(start, end);
        decorations.push(range);
      } catch (e) {
        /* errors if the range is empty, just ignore */
      }
    };

    let i = 0;
    if (this.state.breakLine > 0) {
      // @ts-expect-error
      const lines = this.view.state.doc.text;

      for (let j = 0; j < this.state.breakLine - 1; j++) {
        const end = lines[j].length;
        pushNewRange(i, i + end);
        i += lines[j].length + 1;
      }
    }

    pushNewRange(i, i + this.state.breakCh);

    this.decorations = Decoration.set(decorations);
  }
}

const loomEditorPluginSpec: PluginSpec<LoomEditorPlugin> = {
  decorations: (value: LoomEditorPlugin) => value.decorations,
};

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
      dropdown.setValue(this.plugin.settings.provider);
      dropdown.onChange(async (value) => {
        if (PROVIDERS.find((provider) => provider === value))
          this.plugin.settings.provider = value;
        await this.plugin.save();
      });
    });

    const apiKeySetting = (name: string, setting: LSStringProperty) => {
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
