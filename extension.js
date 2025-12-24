const vscode = require('vscode');
const json_parse = require('./json_parse')

let rainbow_token_event = null;

const all_token_types = ['rainbow1', 'rainbow2', 'rainbow3', 'rainbow4', 'rainbow5', 'rainbow6', 'rainbow7', 'rainbow8', 'rainbow9', 'rainbow10'];
const tokens_legend = new vscode.SemanticTokensLegend(all_token_types);


function extend_range_by_margin(vscode, doc, range, margin) {
    let begin_line = Math.max(0, range.start.line - margin);
    let end_line_inclusive = Math.min(doc.lineCount - 1, range.end.line + margin);
    return new vscode.Range(begin_line, range.start.character, end_line_inclusive, range.end.character);
}


function parse_document_range(vscode, doc, range) {
    let lines = [];
	let line_nums = [];
    let begin_line = Math.max(0, range.start.line);
    let end_line = Math.min(doc.lineCount, range.end.line + 1);
    let first_defective_line = null;
    for (let lnum = begin_line; lnum < end_line; lnum++) {
        let line_text = doc.lineAt(lnum).text;
		lines.push(line_text);
		line_nums.push(lnum);
    }
    return [lines, line_nums];
}



function get_rainbow_token_type(depth) {
    return all_token_types[depth % all_token_types.length];
}

function push_node_tokens(builder, node, depth) {
    // Push tokens for this node based on its depth
    let token_type = get_rainbow_token_type(depth);
    
    if (node.node_type === 'SCALAR') {
        // For scalar nodes, highlight the value
        let start_line = node.start_position.line;
        let start_col = node.start_position.column;
        let end_col = node.end_position.column;
        let length = end_col - start_col;
        if (length > 0) {
			let current_range = new vscode.Range(start_line, start_col, start_line, end_col);
            builder.push(current_range, token_type);
        }
    } else {
        for (let child of node.children) {
            push_node_tokens(builder, child, depth + 1);
        }
    }
}

class RainbowTokenProvider {
    // We don't utilize typescript `implement` interface keyword, because TS doesn't seem to be exporting interfaces to JS (unlike classes).
    constructor() {
    }
    async provideDocumentRangeSemanticTokens(document, range, _token) {
		console.log('providing tokens');
		if (document.languageId != "json" && document.languageId != "jsonl") {
			return null;
		}

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
            push_node_tokens(builder, record, base_depth);
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

// this method is called when your extension is deactivated
function deactivate() {}

// eslint-disable-next-line no-undef
module.exports = {
	activate,
	deactivate
}
