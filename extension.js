const vscode = require('vscode');
const json_parse = require('./json_parse')
const rainbow_utils = require('./rainbow_utils');

/** @type {vscode.Disposable|null} */
let rainbow_token_event = null;

let per_doc_reversed_keys_to_highlight = new Map(); // Stores per-doc reversed (leaf->root instead of root->leaf) key paths to highlight.



// Start with rainbow2 because rainbow1 has no color.
const rainbow_token_types = [/*'rainbow1', */'rainbow2', 'rainbow4', 'rainbow10', 'rainbow8', 'rainbow5', 'rainbow6', 'rainbow9', 'rainbow7'/*, 'rainbow3'*/];
const ambient_token_type = 'rainbow3';
const all_token_types = rainbow_token_types.concat(['rainbow1', ambient_token_type]);
const tokens_legend = new vscode.SemanticTokensLegend(all_token_types);

const max_num_keys_to_highlight = rainbow_token_types.length;

// TODO add proper readme with a screenshot.
// TODO improve unit tests
// TODO add min autodetection frequency config option to highlight e.g. 2, to avoid highlighting configs.
// TODO add min number of keys with the min frequency e.g. 2, so we would have 2 x 2 table at least.

// TODO (post MVP): add option to highlight by last key path only.
// TODO (post MVP): use vscode channel for logging like in rainbow csv instead of console.log

/**
 * @param {typeof vscode} vscode
 * @param {vscode.TextDocument} doc
 * @param {vscode.Range} range
 * @param {number} margin
 * @returns {vscode.Range}
 */
function extend_range_by_margin(vscode, doc, range, margin) {
    let begin_line = Math.max(0, range.start.line - margin);
    let end_line_inclusive = Math.min(doc.lineCount - 1, range.end.line + margin);
    return new vscode.Range(begin_line, range.start.character, end_line_inclusive, range.end.character);
}


/**
 * @param {typeof vscode} vscode
 * @param {vscode.TextDocument} doc
 * @param {vscode.Range} range
 * @returns {[string[], number[]]}
 */
function parse_document_range(vscode, doc, range) {
    let lines = [];
    let line_nums = [];
    let begin_line = Math.max(0, range.start.line);
    let end_line = Math.min(doc.lineCount, range.end.line + 1);
    for (let lnum = begin_line; lnum < end_line; lnum++) {
        let line_text = doc.lineAt(lnum).text;
        lines.push(line_text);
        line_nums.push(lnum);
    }
    return [lines, line_nums];
}

function get_keys_to_highlight(document) {
    if (!document.fileName) {
        return [];
    }
    if (!per_doc_reversed_keys_to_highlight.has(document.fileName)) {
        let config = vscode.workspace.getConfiguration('rainbow-json');
        let min_frequency = config.get('autohighlight_key_frequency', 2);
        let min_keys_count = config.get('autohighlight_min_keys_count', 2);

        let [lines, line_nums] = parse_document_range(vscode, document, new vscode.Range(0, 0, document.lineCount, 0));
        let frequency_stats = rainbow_utils.calculate_key_frequency_stats(lines, line_nums);
        frequency_stats = frequency_stats.filter(stat => stat.count >= min_frequency);
        if (frequency_stats.length < min_keys_count) {
            frequency_stats = [];
        }
        frequency_stats = frequency_stats.slice(0, 5);
        let keys_to_highlight = frequency_stats.map(stat => stat.path.slice().reverse());
        per_doc_reversed_keys_to_highlight.set(document.fileName, keys_to_highlight);
    }
    let keys_to_highlight = per_doc_reversed_keys_to_highlight.get(document.fileName);
    if (!keys_to_highlight || !keys_to_highlight.length) {
        return [];
    }
    // Reverse from root -> leaf to leaf -> root so that we can do prefix matching more naturally.
    return keys_to_highlight.map(path => rainbow_utils.get_path_signature(path));
}


function push_ambient_tokens_between_positions(document, ambientTokenType, lastPushedPosition, currentPosition, builder) {
    // Nothing to push if positions are the same or current is before last
    if (currentPosition.isBeforeOrEqual(lastPushedPosition)) {
        return;
    }

    if (lastPushedPosition.line === currentPosition.line) {
        builder.push(new vscode.Range(lastPushedPosition, currentPosition), ambientTokenType);
        return;
    }
    // Multi-line - push token for remainder of first line
    let firstLineText = document.lineAt(lastPushedPosition.line).text;
    if (lastPushedPosition.character < firstLineText.length) {
        let range = new vscode.Range(lastPushedPosition, new vscode.Position(lastPushedPosition.line, firstLineText.length));
        builder.push(range, ambientTokenType);
    }

    // Push tokens for intermediate full lines
    for (let line = lastPushedPosition.line + 1; line < currentPosition.line; line++) {
        let lineText = document.lineAt(line).text;
        if (lineText.length > 0) {
            let range = new vscode.Range(line, 0, line, lineText.length);
            builder.push(range, ambientTokenType);
        }
    }

    // Push token for beginning of last line
    if (currentPosition.character > 0) {
        let range = new vscode.Range(currentPosition.line, 0, currentPosition.line, currentPosition.character);
        builder.push(range, ambientTokenType);
    }
}


/**
 * @param {string[]} keys_to_highlight - Array of paths like "foo->bar"
 * @param {vscode.SemanticTokensBuilder} builder
 * @param {json_parse.RainbowJsonNode} node
 * @param {string} path - Current path
 * @param {vscode.Position} lastPushedPosition
 */
function push_current_node(document, keys_to_highlight, builder, node, current_path, lastPushedPosition) {
    let current_path_signature = rainbow_utils.get_path_signature(current_path.slice().reverse());
    let highlight_index = 0;
    for (highlight_index = 0; highlight_index < keys_to_highlight.length; highlight_index++) {
        if (keys_to_highlight[highlight_index] && keys_to_highlight[highlight_index].startsWith(current_path_signature)) {
            break;
        }
    }
    if (highlight_index >= keys_to_highlight.length) {
        return lastPushedPosition;
    }
    let token_type = rainbow_token_types[highlight_index % rainbow_token_types.length];
    let start_line = node.parent_key_position.line;
    let end_line = start_line;
    let start_col = node.parent_key_position.character;
    let end_col = start_col + node.parent_key.length;
    if (node.node_type === 'SCALAR' && node.value !== null) {
        // For scalar nodes highlight the whole key-value pair.
        end_line = node.end_position.line;
        end_col = node.end_position.character;
    }
    let current_range_start = new vscode.Position(start_line, start_col);
    let current_range_end = new vscode.Position(end_line, end_col);
    push_ambient_tokens_between_positions(document, ambient_token_type, lastPushedPosition, current_range_start, builder);
    let current_range = new vscode.Range(current_range_start, current_range_end);
    builder.push(current_range, token_type);
    return current_range_end;
}

/**
 * @param {string[]} keys_to_highlight - Array of paths like "foo->bar"
 * @param {vscode.SemanticTokensBuilder} builder
 * @param {json_parse.RainbowJsonNode} node
 * @param {string} path - Current path
 * @param {vscode.Position} lastPushedPosition - Start position of the range being processed
 */
function push_node_tokens(document, keys_to_highlight, builder, node, path, lastPushedPosition) {
    path = path.slice();
    if (node.parent_key) { // Arrays elements don't have parent_key, so path doesn't change which is exactly what is needed.
        path.push(node.parent_key);
        lastPushedPosition = push_current_node(document, keys_to_highlight, builder, node, path, lastPushedPosition);
    }
    for (let child of node.children) {
        lastPushedPosition = push_node_tokens(document, keys_to_highlight, builder, child, path, lastPushedPosition);
    }
    return lastPushedPosition;
}

class RainbowTokenProvider {
    // We don't utilize typescript `implement` interface keyword, because TS doesn't seem to be exporting interfaces to JS (unlike classes).
    constructor() {
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Range} range
     * @param {vscode.CancellationToken} _token
     */
    async provideDocumentRangeSemanticTokens(document, range, _token) {
        // TODO re-evaluate error-handling strategy to make sure it is sensible.
        if (document.languageId != "json" && document.languageId != "jsonl") {
            return null;
        }
        let keys_to_highlight = get_keys_to_highlight(document);

        const builder = new vscode.SemanticTokensBuilder(tokens_legend);

        // Early return if no non-null keys to highlight
        if (!keys_to_highlight.length || keys_to_highlight.every(k => k === null)) {
            console.log('No keys to highlight found.');
            return builder.build();
        }

        let parsing_range = extend_range_by_margin(vscode, document, range, 100);
        let [lines, line_nums] = parse_document_range(vscode, document, parsing_range);
        let records;
        try {
            records = json_parse.parse_json_objects(lines, line_nums);
        } catch (e) {
            // If parsing fails, return empty tokens
            return builder.build();
        }
        let lastPushedPosition = parsing_range.start;
        for (let record of records) {
            // TODO consider passing extracted lines array instead of document itself or consider not extracting lines in the first place.
            lastPushedPosition = push_node_tokens(document, keys_to_highlight, builder, record, /*path=*/[], lastPushedPosition);
        }
        push_ambient_tokens_between_positions(document, ambient_token_type, lastPushedPosition, parsing_range.end, builder);

        return builder.build();
    }
}


function enable_dynamic_semantic_tokenization() {
    // Some themes can disable semantic highlighting e.g. "Tokyo Night" https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night, so we explicitly override the default setting in "configurationDefaults" section of package.json.
    // Conflict with some other extensions might also cause semantic highlighting to completely fail (although this could be caused by the theme issue described above), see https://github.com/mechatroner/vscode_rainbow_csv/issues/149.
    console.log('Enabling dynamic semantic tokenization');
    let token_provider = new RainbowTokenProvider();
    if (rainbow_token_event !== null) {
        rainbow_token_event.dispose();
    }
    // TODO handle jsonc - needs parser adjustment. Also add jsonc to "configurationDefaults":"editor.semanticHighlighting.enabled" list.
    let document_selector = [{ language: "json" }, { language: "jsonl" }];
    rainbow_token_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(document_selector, token_provider, tokens_legend);
    console.log('Dynamic semantic tokenization enabled');
}

function disable_dynamic_semantic_tokenization() {
    console.log('Disabling dynamic semantic tokenization');
    if (rainbow_token_event !== null) {
        rainbow_token_event.dispose();
        rainbow_token_event = null;
    }
}


/**
 * Find the key path at a given position in the document
 * @param {json_parse.RainbowJsonNode} node
 * @param {vscode.Position} position
 * @param {string[]} current_path
 * @returns {string[]|null} - The path to the key at position, or null if not found
 */
function find_key_path_at_position(node, position, current_path) {
    current_path = current_path.slice();
    if (node.parent_key) {
        current_path.push(node.parent_key);
        let parent_key_range = node.getParentKeyRange();
        if (parent_key_range && parent_key_range.contains(position)) {
            return current_path;
        }

        // For scalar nodes, also check if position is within the value
        if (node.node_type === 'SCALAR') {
            let scalar_range = node.getValueRange();
            if (scalar_range && scalar_range.contains(position)) {
                return current_path;
            }
        }
    }

    // Recursively check children
    for (let child of node.children) {
        let result = find_key_path_at_position(child, position, current_path);
        if (result) {
            return result;
        }
    }

    return null;
}

/**
 * Find key path at cursor position in the document
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {string[]|null}
 */
function get_key_path_at_cursor(document, position) {
    let [lines, line_nums] = parse_document_range(vscode, document, new vscode.Range(0, 0, document.lineCount, 0));
    let records;
    try {
        records = json_parse.parse_json_objects(lines, line_nums);
    } catch (e) {
        console.log('JSON parsing error:', e.message);
        return null;
    }

    for (let record of records) {
        let path = find_key_path_at_position(record, position, []);
        if (path) {
            return path;
        }
    }
    return null;
}

/**
 * Toggle a key path in the highlight list for a document
 * @param {vscode.TextDocument} document
 * @param {string[]} key_path - Path in root->leaf order
 */
function toggle_key_highlight(document, key_path) {
    if (!document.fileName) {
        vscode.window.showErrorMessage('Cannot toggle highlight: document has no file name');
        return;
    }

    let reversed_path = key_path.slice().reverse();

    if (!per_doc_reversed_keys_to_highlight.has(document.fileName)) {
        per_doc_reversed_keys_to_highlight.set(document.fileName, []);
    }

    let keys_list = per_doc_reversed_keys_to_highlight.get(document.fileName);
    let target_key_path_signature = rainbow_utils.get_path_signature(reversed_path);

    // Check if path already exists
    let existing_index = keys_list.findIndex(existing => rainbow_utils.get_path_signature(existing) === target_key_path_signature);

    if (existing_index !== -1) {
        // Remove key by replacing it with null instead of removing from the list - this preserves consistency of color mapping for other keys.
        keys_list[existing_index] = null;
        console.log(`Removed highlight for key: ${rainbow_utils.get_path_signature(key_path)}`);
    } else {
        let first_null_index = 0;
        while (first_null_index < keys_list.length) {
            if (keys_list[first_null_index] === null) {
                break;
            }
            first_null_index += 1;
        }
        if (first_null_index < keys_list.length) {
            keys_list[first_null_index] = reversed_path;
        } else if (first_null_index >= max_num_keys_to_highlight) {
            vscode.window.showErrorMessage(`Too many keys selected (max ${max_num_keys_to_highlight}). Remove some keys first.`);
            return;
        } else {
            keys_list.push(reversed_path);
        }
        console.log(`Added highlight for key: ${rainbow_utils.get_path_signature(key_path)}`);
    }

    // Trigger re-tokenization by refreshing semantic tokens
    // This is done by re-registering the provider which forces a refresh
    enable_dynamic_semantic_tokenization();
}


/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
    console.log('Activating Rainbow JSON');

    enable_dynamic_semantic_tokenization();
    let enable_disposable = vscode.commands.registerCommand('rainbow-json.Enable', () => {
        enable_dynamic_semantic_tokenization();
    });
    let disable_disposable = vscode.commands.registerCommand('rainbow-json.Disable', () => {
        disable_dynamic_semantic_tokenization();
    });
    let toggle_key_disposable = vscode.commands.registerCommand('rainbow-json.ToggleKeyHighlight', () => {
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor');
            return;
        }
        let document = editor.document;
        if (document.languageId !== 'json' && document.languageId !== 'jsonl') {
            vscode.window.showErrorMessage('Not a JSON file');
            return;
        }
        let position = editor.selection.active;
        let key_path = get_key_path_at_cursor(document, position);
        if (!key_path || key_path.length === 0) {
            vscode.window.showErrorMessage('No JSON key found at cursor position');
            return;
        }
        toggle_key_highlight(document, key_path);
    });

    // TODO: enable this post-MVP. Or figure out if you can use decorations to hide the bracket colors.
    // for (let language_id of ["json", "jsonl"]) {
    //     let config = vscode.workspace.getConfiguration('editor', {languageId: language_id});
    //     // Adjusting these settings as `configurationDefaults` in package.json doesn't work reliably, so we set it here dynamically.
    //     // TODO consider adjusting on workspace level only instead.
    //     let update_global_settings = true;
    //     if (config.get('bracketPairColorization.enabled')) {
    //         await config.update('bracketPairColorization.enabled', false, /*configurationTarget=*/update_global_settings, /*overrideInLanguage=*/true);
    //     }
    // }

    context.subscriptions.push(enable_disposable);
    context.subscriptions.push(disable_disposable);
    context.subscriptions.push(toggle_key_disposable);
}

function deactivate() {}

// eslint-disable-next-line no-undef
module.exports = {
    activate,
    deactivate
}
