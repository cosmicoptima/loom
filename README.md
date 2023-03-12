[loom](https://github.com/socketteer/loom) in obsidian

i currently **recommend reading through this readme**, as the plugin might otherwise be confusing
or inexplicably broken under some conditions, especially if you are new to loom or to obsidian

default hotkeys:
- `Ctrl+Space` - complete  
- `Ctrl+Alt+n` - create child  
- `Alt+n` - create sibling  
- `Alt+c` - split in-range node at caret (<- this is poorly explained but useful! try it!)  
- `Ctrl+Alt+c` - clone current node  
- `Alt+Backspace` - delete current node  
- `Alt+Down` - switch to next sibling  
- `Alt+Up` - switch to previous sibling  
- `Alt+Left` - switch to parent  
- `Alt+Right` - switch to (most recently visited) child  
- `Alt+e` - collapse/expand current node

the following commands don't have hotkeys by default:
- open loom pane  
- delete current node's children  
- delete current node's siblings  
- (debug) reset state

buttons shown when hovering over a node in the loom pane:
- hoist (only show this node and its children)  
- create sibling  
- create child  
- delete  

to install\*, clone this repository into a directory in `[vault]/.obsidian/plugins`.
in the plugin directory, run `npm i` and `npm run build`. you will need node.js 14 or higher.
enable the plugin and set the openai api key in the `Loom` settings tab

\*i haven't tested this on windows

**for those new to obsidian:** the loom ui, containing a tree of the selected note's nodes,
is not open by default. to open it, you can either:

1. open the command palette with `Ctrl+P`, then search for and run the "open loom pane" command
2. open the right sidebar -- there is a toggle in the top right of the screen -- and switch to
the loom tab*

*the tab looks like this:  
![network](https://github.com/cosmicoptima/loom/raw/master/assets/loom_tab.png)

**for those on macos:** a few default hotkeys -- `Alt+n`, `Alt+c`, and `Alt+e` -- are bound to
special characters. at some point i will try to think of hotkeys that don't conflict with anything,
but for now you can either:

1. disable macos's special character shortcuts, as explained here: https://superuser.com/questions/941286/disable-default-option-key-binding
2. rebind the loom hotkeys you want to use in the "Hotkeys" tab in settings
