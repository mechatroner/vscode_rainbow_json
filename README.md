# Rainbow JSON

Highlight repeating keys in JSON datasets in different colors for better readability. 


![screenshot](https://i.imgur.com/GfcCGhw.png)


## Usage

Rainbow JSON overrides the default JSON syntax and instead adds color coding to repeated json keys.  
Users can also manually toggle highlighting for any key under the cursor using `"Rainbow JSON" -> "Toggle Key Highlight"` editor context menu. 

To revert back to the built-in (default) JSON highlighting select `"Rainbow JSON" -> "Disable Highlighting"` in the context menu.

### Rainbow Auto-highlight

Rainbow JSON uses a heuristic to avoid highlighting of non-dataset JSON files e.g. configs.  
The extension only auto-highlights files where there are at least 2 keys occurring at least 2 times each.  
Both the minimal frequency and minimal number of keys for auto-highlighting can be adjusted in the settings. 
