# loom(sidian)

This is a reimplementation of [Loom](https://github.com/socketteer/loom) as an Obsidian plugin, designed to be easier to use and more modular and extensible.

Loom is a recursively branching interface to GPT-3 and other language models; it is designed to be conducive to exploratory and experimental use of base models. The workflow primarily consists of this: you hit `Ctrl+Space` from a point in the text, and Loom generates `n` child nodes of the current node, where each child contains a different completion of the text leading up to the cursor. This is paired with a tree interface and settings panel in the right sidebar, as well as a pane containing the full text of the current node and its siblings.

**If you are new to Obsidian:** if you want to see the tree interface, make sure to open the right sidebar using the button on the top right, or using `Ctrl+P` then `Toggle right sidebar`. Once you've done that, go to the Loom tab, which is signified by a network icon.

Default hotkeys:
- `Ctrl+Space` - complete
- `Ctrl+Alt+n` - create child
- `Alt+n` - create sibling
- `Ctrl+Alt+c` - clone current node
- `Alt+c` - split in-range node at caret

- `Alt+Backspace` - delete current node
- `Alt+Down` - switch to next sibling
- `Alt+Up` - switch to previous sibling
- `Alt+Left` - switch to parent
- `Alt+Right` - switch to (most recently visited) child
- `Alt+e` - collapse/expand current node

In the editor:
- `Shift+click` on the text corresponding to a node to switch to it

**If you are using MacOS:** a few hotkeys -- `Alt+n`, `Alt+c` and `Alt+e` -- are bound to special characters. You can either:

1. Disable MacOS's special character shortcuts, as explained here: https://superuser.com/questions/941286/disable-default-option-key-binding
2. Rebind the Loom hotkeys you want to use in the Hotkeys tab in Settings
