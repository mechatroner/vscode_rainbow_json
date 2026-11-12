const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');
const stream = require('stream');

const vscode = require('vscode');

const json_parse = require('./json_parse');
const rainbow_utils = require('./rainbow_utils');
const rbql_json = require('./rbql_core/rbql-js/rbql_json.js');
const rbql = require('./rbql_core/rbql-js/rbql.js');

/** @type {vscode.Disposable|null} */
let rainbow_token_event = null;

let per_doc_reversed_keys_to_highlight = new Map(); // Stores per-doc reversed (leaf->root instead of root->leaf) key paths to highlight.

let client_html_template = null;
var web_extension_uri = null;

// Start with rainbow2 because rainbow1 has no color.
const rainbow_token_types = [/*'rainbow1', */'rainbow2', 'rainbow4', 'rainbow10', 'rainbow8', 'rainbow5', 'rainbow6', 'rainbow9', 'rainbow7'/*, 'rainbow3'*/];
const ambient_token_type = 'rainbow3';
const all_token_types = rainbow_token_types.concat(['rainbow1', ambient_token_type]);
const tokens_legend = new vscode.SemanticTokensLegend(all_token_types);

const max_num_keys_to_highlight = rainbow_token_types.length;
const scratch_buf_marker = 'vscode_rbql_scratch';
let rbql_context = null;

var _unit_test_last_warnings = null; // For unit tests only.
var _unit_test_last_rbql_report = null; // For unit tests only.

// TODO add proper readme with a screenshot.

// TODO (post MVP): add option to highlight by last key path only.
// TODO (post MVP): use vscode channel for logging like in rainbow csv instead of console.log


const preview_window_size = 20;
const is_web_ext = (os.homedir === undefined); // Runs as web extension in browser.

// This `global_state` is persistent across VSCode restarts.
let global_state = null;

let last_rbql_queries = new Map(); // Query history does not replace this structure, it is also used to store partially entered queries for preview window switch.

var debug_log_output_channel = null;

let extension_context = {
    autodetection_temporarily_disabled_for_rbql: false,
    dynamic_dialect_for_next_request: null,
    logging_enabled: false,
    logging_next_context_id: 1
};

class RainbowJsonError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RainbowJsonError';
    }
}


class AssertionError extends Error {}

function assert(condition, message=null) {
    if (!condition) {
        if (!message) {
            message = 'Assertion error';
        }
        throw new AssertionError(message);
    }
}


class StackContextLogWrapper {
    // Use class instead of pure function to avoid passing context name and checking if logging is enabled in the config in each call.
    constructor(context_name, caller_context_id=null) {
        this.context_name = context_name;
        this.logging_enabled = extension_context.logging_enabled;
        this.context_id = caller_context_id === null ? extension_context.logging_next_context_id : caller_context_id;
        extension_context.logging_next_context_id += 1;
    }

    log_doc_event(event_name, vscode_doc=null) {
        if (!this.logging_enabled)
            return;
        try {
            let full_event = `CID:${this.context_id}, ${this.context_name}:${event_name}`;
            if (vscode_doc) {
                full_event = `${full_event}, doc_lang:${vscode_doc.languageId}`;
                if (vscode_doc.uri) {
                    let str_uri = vscode_doc.uri.toString(/*skipEncoding=*/true);
                    full_event = `${full_event}, doc_uri:${str_uri}`;
                }
            } else {
                full_event = `${full_event}, no_doc:1`;
            }
            // Use "info" level because logging is flag-guarded by the extension-level setting.
            debug_log_output_channel.info(full_event);
        } catch (_error) {
            console.error(`Rainbow JSON: Unexpected log failure. ${this.context_name}:${this.event_name}`);
            return;
        }
    }

    log_simple_event(event_name) {
        if (!this.logging_enabled)
            return;
        try {
            let full_event = `CID:${this.context_id}, ${this.context_name}:${event_name}`;
            debug_log_output_channel.info(full_event);
        } catch (_error) {
            console.error(`Rainbow JSON: Unexpected log failure. ${this.context_name}:${this.event_name}`);
            return;
        }
    }
}


function parse_json_string_as_stream(text) {
    let balancing_iterator = new rbql_json.BalancingIterator();
    balancing_iterator.add_fragment(text);
    let records = [];
    while (!balancing_iterator.empty()) {
        records.push(balancing_iterator.advance());
    }
    balancing_iterator.finish();
    return records;
}


function full_doc_parse(vscode_doc) {
    const starts_with_square_bracket_rgx = /^\s*\[/;
    //const ends_with_square_bracket_rgx = /\]\s*$/;
    let doc_text = vscode_doc.getText();
    if (starts_with_square_bracket_rgx.test(doc_text)) {
        try {
            let root_array = JSON.parse(doc_text);
            assert(Array.isArray(root_array)); // This must be true because we parsed it and it starts with a square bracket.
            return [true, root_array];
        } catch (e) {
            // Do nothing, not a single array, proceed with stream mode.
        }
    }
    let records = parse_json_string_as_stream(doc_text);
    return [false, records];
}


// The main purpose of this class is to map doc_id -> records list for RBQL preview.
// It does full doc parsing which can be expensive so we only do this when RBQL interface requested and only if document was updated.
class FullDocRecordCache {
    constructor() {
        this.doc_records = new Map();
    }
    get_document_records(vscode_doc) {
        let file_name = vscode_doc.fileName;
        if (!file_name) {
            return;
        }
        let cache_entry = this.doc_records.get(file_name);
        if (!cache_entry || cache_entry.version != vscode_doc.version) {
            let [is_array, records] = full_doc_parse(vscode_doc);
            cache_entry = {'version': vscode_doc.version, 'is_array': is_array, 'records': records};
            this.doc_records.set(file_name, cache_entry);
        }
        return [cache_entry.records, cache_entry.is_array];
    }
}

let rbql_preview_records_cache = new FullDocRecordCache();

function extend_range_by_margin(vscode, doc, range, margin) {
    let begin_line = Math.max(0, range.start.line - margin);
    let end_line_inclusive = Math.min(doc.lineCount - 1, range.end.line + margin);
    return new vscode.Range(begin_line, range.start.character, end_line_inclusive, range.end.character);
}


function show_single_line_error(error_msg) {
    var active_window = vscode.window;
    if (!active_window)
        return;
    // Do not "await" error messages because the promise gets resolved only on error dismissal.
    active_window.showErrorMessage(error_msg);
}


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
        let max_keys_count = config.get('autohighlight_max_keys_count', 5);
        max_keys_count = Math.min(max_keys_count, rainbow_token_types.length);

        let [lines, line_nums] = parse_document_range(vscode, document, new vscode.Range(0, 0, document.lineCount, 0));
        let frequency_stats = rainbow_utils.calculate_key_frequency_stats(lines, line_nums);
        frequency_stats = frequency_stats.filter(stat => stat.count >= min_frequency);
        if (frequency_stats.length < min_keys_count) {
            frequency_stats = [];
        }
        frequency_stats = frequency_stats.slice(0, max_keys_count);
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


async function load_resource_file_for_web(extension_uri, resource_path) {
    let resource_uri = vscode.Uri.joinPath(extension_uri, resource_path);
    let bytes = await vscode.workspace.fs.readFile(resource_uri);
    // Using TextDecoder because it should work fine in web extension.
    return new TextDecoder().decode(bytes);
}


async function load_resource_file_universal(resource_path) {
    let resource_data = await load_resource_file_for_web(web_extension_uri, resource_path);
    return resource_data;
}


function adjust_webview_paths(preview_panel, client_html, paths_list) {
    for (const local_path of paths_list) {
        let adjusted_webview_url = preview_panel.webview.asWebviewUri(vscode.Uri.joinPath(web_extension_uri, local_path)); // FIXME make sure it works in web mode too.
        client_html = client_html.replace(`src="${local_path}"`, `src="${adjusted_webview_url}"`);
    }
    return client_html;
}


function sample_preview_records_from_context(rbql_context, dst_message, preview_window_size) {
    let [records, is_array] = rbql_preview_records_cache.get_document_records(rbql_context.input_document);
    rbql_context.requested_start_record = Math.max(0, Math.min(rbql_context.requested_start_record, records.length - preview_window_size));
    let preview_records = records.slice(rbql_context.requested_start_record, rbql_context.requested_start_record + preview_window_size);
    dst_message.is_array = is_array;
    dst_message.preview_records = preview_records;
    dst_message.actual_start_record = rbql_context.requested_start_record;
}


function file_path_to_query_key(file_path) {
    return (file_path && file_path.indexOf(scratch_buf_marker) != -1) ? scratch_buf_marker : file_path;
}


function get_from_global_state(key, default_value) {
    // Load KV pair from the "global state" which is persistent across VSCode restarts.
    if (global_state) {
        var value = global_state.get(key);
        if (value !== null && value !== undefined)
            return value;
    }
    return default_value;
}


async function save_to_global_state(key, value) {
    // Save KV pair to the "global state" which is persistent across VSCode restarts.
    if (global_state && key) {
        await global_state.update(key, value);
        return true;
    }
    return false;
}


async function update_query_history(query) {
    let history_list = get_from_global_state('rbql_query_history', []);
    let old_index = history_list.indexOf(query);
    if (old_index != -1) {
        history_list.splice(old_index, 1);
    } else if (history_list.length >= 20) {
        history_list.splice(0, 1);
    }
    history_list.push(query);
    await save_to_global_state('rbql_query_history', history_list);
}


// In node there is no standard way to create a writable stream backed by a string, so we use this ad-hoc implementation.
function PseudoWritable() {
    this.data_chunks = [];
    this.encoding = 'utf-8';
    this.unused_error_callback = null;

    this.setDefaultEncoding = function(encoding) {
        this.encoding = encoding;
    };

    this.write = function(data) {
        this.data_chunks.push(data);
    };

    this.get_data = function() {
        return Buffer.from(this.data_chunks.join(''), this.encoding);
    };

    this.get_text = function() {
        return this.data_chunks.join('');
    };

    this.on = function(msg_type, _unused_error_callback) {
        assert(msg_type === 'error');
    };
}


function read_user_init_code(rbql_init_source_path) {
    return fs.readFileSync(rbql_init_source_path, 'utf-8');
}


async function rbql_query_web(query_text, input_document, unwrap_input, wrap_output, pretty_print, output_warnings) {
    let user_init_code = '';
    let default_init_source_path = path.join(os.homedir(), '.rbql_init_source.js');
    if (!is_web_ext && fs.existsSync(default_init_source_path)) {
        user_init_code = read_user_init_code(default_init_source_path);
    }
    let join_tables_registry = null;
    let output_stream = new PseudoWritable();
    let input_stream = stream.Readable.from([input_document.getText()]);
    let input_iterator = new rbql_json.JsonIterator(input_stream, unwrap_input, /*encoding=*/null);
    let close_output_on_finish = false;
    let pretty_indent = pretty_print ? 4 : null;
    let output_writer = new rbql_json.JsonWriter(output_stream, close_output_on_finish, 'utf-8', '\n', pretty_indent, wrap_output);
    await rbql.query(query_text, input_iterator, output_writer, output_warnings, join_tables_registry, user_init_code);
    return output_stream.get_text();
}


async function show_warnings(warnings) {
    _unit_test_last_warnings = [];
    if (!warnings || !warnings.length)
        return;
    var active_window = vscode.window;
    if (!active_window)
        return null;
    for (var i = 0; i < warnings.length; i++) {
        // Do not "await" warning messages because the promise gets resolved only on warning dismissal.
        active_window.showWarningMessage('RBQL warning: ' + warnings[i]);
    }
    _unit_test_last_warnings = warnings;
}


async function handle_rbql_result_file_web(text_doc, warnings) {
    try {
        await vscode.window.showTextDocument(text_doc);
    } catch (_error) {
        show_single_line_error('Unable to open RBQL result document');
        return;
    }
    await show_warnings(warnings);
}


async function run_rbql_query(webview, input_path, backend_language, rbql_query, unwrap_input, wrap_output, pretty_print, integration_test_options=null) {
    let log_wrapper = new StackContextLogWrapper('run-rbql-query');
    log_wrapper.log_simple_event('start');
    last_rbql_queries.set(file_path_to_query_key(input_path), rbql_query);

    if (backend_language == 'js') {
        log_wrapper.log_simple_event('using js backend');
        let warnings = [];
        let result_doc = null;
        try {
            log_wrapper.log_simple_event('using web mode');
            let result_content = await rbql_query_web(rbql_query, rbql_context.input_document, unwrap_input, wrap_output, pretty_print, warnings);
            let output_doc_cfg = {content: result_content, language: 'json'};
            extension_context.autodetection_temporarily_disabled_for_rbql = true;
            result_doc = await vscode.workspace.openTextDocument(output_doc_cfg);
            await send_report_to_webview(webview, null, null);
            await handle_rbql_result_file_web(result_doc, warnings);
            extension_context.dynamic_dialect_for_next_request = null;
            extension_context.autodetection_temporarily_disabled_for_rbql = false;
            log_wrapper.log_simple_event('finished OK');
        } catch (e) {
            extension_context.autodetection_temporarily_disabled_for_rbql = false;
            let [error_type, error_msg] = rbql.exception_to_error_info(e);
            log_wrapper.log_simple_event('finished with error');
            await send_report_to_webview(webview, error_type, error_msg);
            return;
        }
    } else {
        // FIXME make sure it is not a web mode first, otherwise report an error.
        if (orig_uri.scheme == 'file' && active_doc.isDirty) {
            await send_report_to_webview(webview, 'Env error', 'Unable to run: input file has unsaved changes');
            return;
        }
        // FIXME support python backend.
    }
}


async function send_report_to_webview(webview, error_type, error_msg) {
    let report_msg = {'msg_type': 'rbql_report'};
    if (error_type)
        report_msg["error_type"] = error_type;
    if (error_msg)
        report_msg["error_msg"] = error_msg;
    _unit_test_last_rbql_report = report_msg;
    await webview.postMessage(report_msg);
}


async function handle_rbql_client_message(webview, message, integration_test_options=null) {
    let message_type = message['msg_type'];

    if (message_type == 'handshake') {
        var backend_language = get_from_global_state('rbql_backend_language', 'js');
        var init_msg = {'msg_type': 'handshake', 'backend_language': backend_language};
        sample_preview_records_from_context(rbql_context, init_msg, preview_window_size);
        let path_key = file_path_to_query_key(rbql_context.input_document_path);
        if (last_rbql_queries.has(path_key))
            init_msg['last_query'] = last_rbql_queries.get(path_key);
        let history_list = get_from_global_state('rbql_query_history', []);
        init_msg['query_history'] = history_list;
        if (integration_test_options) {
            init_msg['integration_test_language'] = integration_test_options.rbql_backend;
            init_msg['integration_test_query'] = integration_test_options.rbql_query;
            init_msg['integration_test_with_headers'] = integration_test_options.with_headers || false;
            init_msg['integration_test_delay'] = integration_test_options.integration_test_delay || 2000;
        }
        await webview.postMessage(init_msg);
    }

    if (message_type == 'update_query') {
        let rbql_query = message['query'];
        if (!rbql_query)
            return;
        if (rbql_context.input_document_path)
            last_rbql_queries.set(file_path_to_query_key(rbql_context.input_document_path), rbql_query);
    }

    if (message_type == 'navigate') {
        var navig_direction = message['direction'];
        if (navig_direction == 'backward') {
            rbql_context.requested_start_record -= preview_window_size;
        } else if (navig_direction == 'forward') {
            rbql_context.requested_start_record += preview_window_size;
        } else if (navig_direction == 'begin') {
            rbql_context.requested_start_record = 0;
        } else if (navig_direction == 'end') {
            rbql_context.requested_start_record = rbql_context.input_document.lineCount; // This is just max possible value which is incorrect and will be adjusted later.
        }
        let protocol_message = {'msg_type': 'navigate'};
        sample_preview_records_from_context(rbql_context, protocol_message, preview_window_size);
        await webview.postMessage(protocol_message);
    }

    if (message_type == 'run') {
        let rbql_query = message['query'];
        let backend_language = message['backend_language'];
        let unwrap_input = message['unwrap_input'];
        let wrap_output = message['wrap_output'];
        let pretty_print = message['pretty_print'];
        await update_query_history(rbql_query);
        await run_rbql_query(webview, rbql_context.input_document_path, backend_language, rbql_query, unwrap_input, wrap_output, pretty_print, integration_test_options);
    }

    if (message_type == 'edit_udf') {
        if (is_web_ext) {
            await send_report_to_webview(webview, 'Input error', 'UDFs are currently not supported in web version');
            return;
        }
        let backend_language = message['backend_language'];
        let udf_file_path = null;
        let default_content = '';
        if (backend_language == 'js') {
            udf_file_path = path.join(os.homedir(), '.rbql_init_source.js');
            default_content = rainbow_utils.get_default_js_udf_content();
        } else {
            udf_file_path = path.join(os.homedir(), '.rbql_init_source.py');
            default_content = rainbow_utils.get_default_python_udf_content();
        }
        if (!fs.existsSync(udf_file_path)) {
            fs.writeFileSync(udf_file_path, default_content);
        }
        let udf_doc = await vscode.workspace.openTextDocument(udf_file_path);
        await vscode.window.showTextDocument(udf_doc);
    }

    if (message_type == 'global_param_change') {
        await save_to_global_state(message['key'], message['value']);
    }
}


async function edit_rbql(integration_test_options=null) {
    let active_window = vscode.window;
    if (!active_window)
        return;
    let active_editor = active_window.activeTextEditor;
    if (!active_editor)
        return;
    let active_doc = active_editor.document;
    if (!active_doc)
        return;
    let orig_uri = active_doc.uri;
    if (!orig_uri)
        return;
    // For web orig_uri.scheme can have other valid values e.g. `vscode-test-web` when testing the browser integration.
    if (orig_uri.scheme != 'file' && orig_uri.scheme != 'untitled')
        return;
    input_path = active_doc.fileName;
    if (!input_path) {
        show_single_line_error("Unable to run RBQL for this file");
        return;
    }

    rbql_context = {
        "input_document": active_doc,
        "input_document_path": input_path,
        "requested_start_record": 0
    };

    let rbql_preview_panel = vscode.window.createWebviewPanel('rbql-console', 'RBQL Console', vscode.ViewColumn.Active, {enableScripts: true});
    if (!client_html_template) {
        client_html_template = await load_resource_file_universal('rbql_client.html');
    }
    rbql_preview_panel.webview.html = adjust_webview_paths(rbql_preview_panel, client_html_template, ['rbql_client.js']);
    // A minor optimization here could be to pre-parse the records by calling the cache so we don't wait for them during the handshake, but it doesn't worth it.
    rbql_preview_panel.webview.onDidReceiveMessage(function(message) { handle_rbql_client_message(rbql_preview_panel.webview, message, integration_test_options); });
}



async function activate(context) {
    console.log('Activating Rainbow JSON');
    web_extension_uri = context.extensionUri;
    global_state = context.globalState;

    enable_dynamic_semantic_tokenization();
    let enable_disposable = vscode.commands.registerCommand('rainbow-json.Enable', () => {
        enable_dynamic_semantic_tokenization();
    });
    let disable_disposable = vscode.commands.registerCommand('rainbow-json.Disable', () => {
        disable_dynamic_semantic_tokenization();
    });
    let rbql_cmd = vscode.commands.registerCommand('rainbow-json.RBQL', edit_rbql);
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

    try {
        debug_log_output_channel = vscode.window.createOutputChannel('rainbow_json_debug_channel', {log: true});
    } catch (_error) {
        console.error('Rainbow JSON: Failed to create output log channel');
    }

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
    context.subscriptions.push(rbql_cmd);
}

function deactivate() {}

// eslint-disable-next-line no-undef
module.exports = {
    activate,
    deactivate
};
