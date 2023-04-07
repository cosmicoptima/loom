# loom(sidian)

This is a reimplementation of [Loom](https://github.com/socketteer/loom) as an Obsidian plugin, designed to be easier to use and more modular and extensible.

Loom is a recursively branching interface to GPT-3 and other language models; it is designed to be conducive to exploratory and experimental use of base models. The workflow primarily consists of this: you hit `Ctrl+Space` from a point in the text, and Loom generates `n` child nodes of the current node, where each child contains a different completion of the text leading up to the cursor. This is paired with a tree interface and settings panel in the right sidebar, as well as a pane containing the full text of the current node and its siblings.

**If you are new to Obsidian:** if you want to see the tree interface, make sure to open the right sidebar using the button on the top right, or using `Ctrl+P` then `Toggle right sidebar`. Once you've done that, go to the Loom tab, which is signified by a network icon.

**Default hotkeys:**

- `Ctrl+Space` - complete
- `Ctrl+Alt+n` - create child
- `Alt+n` - create sibling
- `Ctrl+Alt+c` - clone current node
- `Alt+c` - split in-range node at caret
- `Alt+Backspace` - delete current node

Navigation:
- `Alt+Down` - switch to next sibling
- `Alt+Up` - switch to previous sibling
- `Alt+Left` - switch to parent
- `Alt+Right` - switch to (most recently visited) child
- `Alt+e` - collapse/expand current node

In the editor:
- `Shift+click` on the text corresponding to a node to switch to it

**How to install** (until Loom is added to the Obsidian store)**:**

1. Go to the latest release under the "Releases" subheading on the right
2. Download the zip file under "Assets"
3. Unzip the file you downloaded in `[path to vault]/.obsidian/plugins`
4. Go to the "Community plugins" tab in Obsidian settings, then enable "Loom"

Alternatively, you can build from source, which makes it easy to update:

1. Clone this repository (`git clone https://github.com/cosmicoptima/loom`) in `[path to vault]/.obsidian/plugins`
2. Run the following: `cd loom; npm i; npm run build`
3. Go to the "Community plugins" tab in Obsidian settings, then enable "Loom"
4. To update, go to the repository and `git pull`, then disable and re-enable Loom

**If you are using MacOS:** a few hotkeys -- `Alt+n`, `Alt+c` and `Alt+e` -- are bound to special characters. You can either:

1. Disable MacOS's special character shortcuts, as explained here: https://superuser.com/questions/941286/disable-default-option-key-binding
2. Rebind the Loom hotkeys you want to use in the Hotkeys tab in Settings
