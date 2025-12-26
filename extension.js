const vscode = require('vscode');
const json_parse = require('./json_parse')

/** @type {vscode.Disposable|null} */
let rainbow_token_event = null;

let per_doc_key_frequency_stats = new Map(); // Per-file cached results of most frequent keys for auto-highlight.

// Start with rainbow2 because rainbow1 has no color.
const all_token_types = [/*'rainbow1', */'rainbow2', 'rainbow3', 'rainbow4', 'rainbow5', 'rainbow6', 'rainbow7', 'rainbow8', 'rainbow9', 'rainbow10'];
const tokens_legend = new vscode.SemanticTokensLegend(all_token_types);


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


/**
 * Recursively collects all (key, depth) pairs from a node
 * @param {json_parse.RainbowJsonNode} node
 * @param {number} depth
 * @param {Map<string, {count: number, order: number}>} freq_map
 */
function collect_keys_from_node(node, depth, freq_map) {
    if (node.parent_key) {
        let key = `${node.parent_key}:${depth}`;
        if (freq_map.has(key)) {
            freq_map.get(key).count++;
        } else {
            let key_count = freq_map.size;
            freq_map.set(key, { count: 1, order: key_count, name: node.parent_key, depth: depth });
        }
    }
    
    if (node.children) {
        for (let child of node.children) {
            collect_keys_from_node(child, depth + 1, freq_map);
        }
    }
}

function calculate_key_frequency_stats(document, max_num_keys=10) {
    let [lines, line_nums] = parse_document_range(vscode, document, new vscode.Range(0, 0, 1000, 0));
    let records;
    try {
        records = json_parse.parse_json_objects(lines, line_nums);
    } catch (e) {
        console.log('JSON parsing error in frequency stats:', e.message);
        return [];
    }
    
    // Collect all (key, depth) pairs with frequency and first-seen order
    let freq_map = new Map();    
    for (let record of records) {
        let base_depth = record.relative_depth || 0;
        collect_keys_from_node(record, base_depth, freq_map);
    }
    
    // Convert to array and sort by frequency (desc), then by first-seen order (asc) for ties
    let sorted_pairs = Array.from(freq_map.values())
        .sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return a.order - b.order;
        });
    
    // Return top 10 most frequent (key, depth) pairs
    return sorted_pairs.slice(0, max_num_keys).map(item => ({ key: item.name, depth: item.depth, count: item.count }));
}

function get_keys_to_highlight(document) {
    // TODO allow user to manually select the keys via context menu.
    if (!document.fileName) {
        return [];
    }
    if (!per_doc_key_frequency_stats.has(document.fileName)) {
        per_doc_key_frequency_stats.set(document.fileName, calculate_key_frequency_stats(document));
    }
    let key_frequency_stats = per_doc_key_frequency_stats.get(document.fileName);
    if (!key_frequency_stats || !key_frequency_stats.length) {
        console.log('Key frequency stats empty. Returning.');
        return [];
    }
    return key_frequency_stats.map(stat => `${stat.key}:${stat.depth}`);
}


/**
 * @param {string[]} keys_to_highlight
 * @param {vscode.SemanticTokensBuilder} builder
 * @param {json_parse.RainbowJsonNode} node
 * @param {number} depth
 */
function push_current_node(keys_to_highlight, builder, node, depth) {
    // FIXME for SCALAR nodes highlight both key and value.
    if (!node.parent_key)
        return;
    let highligh_index = keys_to_highlight.indexOf(`${node.parent_key}:${depth}`);
    if (highligh_index === -1) {
        return;
    }
    let token_type = all_token_types[highligh_index % all_token_types.length];
    let start_line = node.parent_key_position.line;
    let start_col = node.parent_key_position.column;
    let end_col = start_col + node.parent_key.length;
    let current_range = new vscode.Range(start_line, start_col, start_line, end_col);
    builder.push(current_range, token_type);
}

// FIXME: it sort of works, but root_array_example_1.json stops highlighing when scrolling at some point. Fix that.

/**
 * @param {string[]} keys_to_highlight
 * @param {vscode.SemanticTokensBuilder} builder
 * @param {json_parse.RainbowJsonNode} node
 * @param {number} depth
 */
function push_node_tokens(keys_to_highlight, builder, node, depth) {
    push_current_node(keys_to_highlight, builder, node, depth);
    for (let child of node.children) {
        push_node_tokens(keys_to_highlight, builder, child, depth + 1);
    }
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
		console.log('providing tokens');
		if (document.languageId != "json" && document.languageId != "jsonl") {
			return null;
		}
        let keys_to_highlight = get_keys_to_highlight(document);

        let parsing_range = extend_range_by_margin(vscode, document, range, 100);
        let [lines, line_nums] = parse_document_range(vscode, document, parsing_range);
        console.log(`Found ${lines.length} lines to parse`);
        let records;
        try {
            records = json_parse.parse_json_objects(lines, line_nums);
        } catch (e) {
            // If parsing fails, return empty tokens
            console.log('JSON parsing error:', e.message);
            return null;
        }
        console.log(`Parsed ${records.length} JSON records`);
        const builder = new vscode.SemanticTokensBuilder(tokens_legend);
        
		// Use depth-based coloring just for test.
        for (let record of records) {
            // Use relative_depth from the record as the base depth. Children nodes don't have relative_dept set.
            let base_depth = record.relative_depth || 0;
            push_node_tokens(keys_to_highlight, builder, record, base_depth);
        }
        
        return builder.build();
    }
}


function enable_dynamic_semantic_tokenization() {
    // Some themes can disable semantic highlighting e.g. "Tokyo Night" https://marketplace.visualstudio.com/items?itemName=enkia.tokyo-night, so we explicitly override the default setting in "configurationDefaults" section of package.json.
    // TODO add all other json dialects to "configurationDefaults":"editor.semanticHighlighting.enabled" override in order to enable comment line highlighting.
    // Conflict with some other extensions might also cause semantic highlighting to completely fail (although this could be caused by the theme issue described above), see https://github.com/mechatroner/vscode_rainbow_csv/issues/149.
    let token_provider = new RainbowTokenProvider();
    if (rainbow_token_event !== null) {
        rainbow_token_event.dispose();
    }
	// TODO handle jsonc - needs parser adjustment.
    let document_selector = [{ language: "json" }, { language: "jsonl" }];
    rainbow_token_event = vscode.languages.registerDocumentRangeSemanticTokensProvider(document_selector, token_provider, tokens_legend);
}


/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	console.log('Congratulations, your extension "helloworld-minimal-sample" is now active!');

	enable_dynamic_semantic_tokenization();
	let disposable = vscode.commands.registerCommand('extension.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World!');
	});

	context.subscriptions.push(disposable);
}

function deactivate() {}

// eslint-disable-next-line no-undef
module.exports = {
	activate,
	deactivate
}
