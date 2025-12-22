// Json tokens can't span multiple lines so we can tokenize them on line-by-line basis which is nice.

// Custom error types
class JsonTokenizerError extends Error {
    constructor(message, line_num, position) {
        super(message);
        this.name = 'JsonTokenizerError';
        this.line_num = line_num;
        this.position = position;
    }
}

class JsonSyntaxError extends Error {
    constructor(message, line_num, position) {
        super(message);
        this.name = 'JsonSyntaxError';
        this.line_num = line_num;
        this.position = position;
    }
}

class JsonIncompleteError extends Error {
    constructor(message) {
        super(message);
        this.name = 'JsonIncompleteError';
    }
}

class JsonToken {
    constructor(value, line_num, position) {
        this.value = value;
        this.line_num = line_num;
        this.position = position;
        
        // Token type flags
        this.constant = false;
        this.string = false;
        this.number = false;
        this.punctuation = false;
    }

    // Punctuation-specific getter methods
    get brace_open() { return this.value === '{'; }
    get brace_close() { return this.value === '}'; }
    get bracket_open() { return this.value === '['; }
    get bracket_close() { return this.value === ']'; }
    get colon() { return this.value === ':'; }
    get comma() { return this.value === ','; }

    isContainerOpen() {
        return this.brace_open || this.bracket_open;
    }

    isContainerClose() {
        return this.brace_close || this.bracket_close;
    }

    isContainerDelim() {
        return this.brace_open || this.brace_close || this.bracket_open || this.bracket_close;
    }

    isMatchingClose(openToken) {
        return (this.brace_close && openToken.brace_open) || 
               (this.bracket_close && openToken.bracket_open);
    }
}

function tokenize_json_line_in_place(line, line_num, dst_tokens) {
    let cursor = 0;
    const length = line.length;

    // Define token patterns using the 'y' (sticky) flag.
    // The 'y' flag ensures matches only occur exactly at .lastIndex
    // String and number patterns regexps are visualized here: https://www.json.org/fatfree.html
    const patterns = [
        { token_type: 'Whitespace', regex: /\s+/y },
        { token_type: 'Constant', regex: /true|false|null/y },
        // String match regex, takex from here: https://stackoverflow.com/a/249937/2898283
        // It is a bit more permissive than the actual JSON string specification.
        { token_type: 'String', regex: /"(?:[^"\\]|\\.)*"/y },
        // Number: Optional negative, followed by 0 or 1-9+digits, optional fraction, optional exponent
        // Taken from here: https://stackoverflow.com/a/13340826/2898283
        { token_type: 'Number', regex: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
        { token_type: 'Punctuation',regex: /[{}[\]:,]/y }
    ];

    while (cursor < length) {
        let matchFound = false;

        for (const { token_type, regex } of patterns) {
            // Set the regex cursor to the current position in the string
            regex.lastIndex = cursor;

            const match = regex.exec(line);
            if (!match) {
                continue;
            }
            const value = match[0];
            // We skip adding Whitespace to the output, but we must advance the cursor
            if (token_type !== 'Whitespace') {
                let token = new JsonToken(value, line_num, cursor);
                
                switch (token_type) {
                    case 'Constant':
                        token.constant = true;
                        break;
                    case 'String':
                        token.string = true;
                        break;
                    case 'Number':
                        token.number = true;
                        break;
                    case 'Punctuation':
                        token.punctuation = true;
                        break;
                }
                dst_tokens.push(token);
            }
            // Advance cursor by the length of the matched string
            cursor += value.length;
            matchFound = true;
            break; // Stop checking patterns for this position
        }

        if (!matchFound) {
            throw new JsonTokenizerError(`Unexpected character: "${line[cursor]}"`, line_num, cursor);
        }
    }
}

function tokenize_json_line(line, line_num=null) {
    tokens = []
    tokenize_json_line_in_place(line, line_num, tokens);
    return tokens;
}


class Position {
    constructor(line, column) {
        this.line = line;
        this.column = column;
    }
}

// Arrays and Indexes are very similar, the difference is that Array keys are implicit - they are just indexes 0, 1, 2, etc.
// So we can use similar data structures for parsing.

// We can have the following KV types:
// Key -> Primitive value
// Key -> Object (RainbowObjectNode)
// Key -> Array
// We can also have the same array elements because object children have keys, and array children have indexes.

const OBJECT_NODE_TYPE = 'OBJECT';
const ARRAY_NODE_TYPE = 'ARRAY';
const SCALAR_NODE_TYPE = 'SCALAR';

class RainbowJsonNode {
    constructor(node_type, parent_key, parent_array_index, start_position) {
        this.node_type = node_type;
        this.parent_key = parent_key; // Key can be null for array or for the root node.
        this.parent_array_index = parent_array_index; // null value means it is not an array element but was mapped directly by the key.
        this.start_position = start_position;
        this.end_position = null;
        this.children = []; // For container nodes.
        this.value = null; // For scalar nodes.
    }
}

class PDAStackFrame {
    constructor(node) {
        this.node = node;
        this.current_nfa_states = [];
        this.current_array_index = 0;
        this.current_key = null;
    }
}

class AutomataState {
    constructor(handler_function, error_string) {
        this.handler_function = handler_function;
        this.error_string = error_string;
    }
}

// Forward declarations - will be defined after all handlers
let expect_key_state, expect_colon_state, expect_value_state, expect_comma_state, expect_object_end_state, expect_array_end_state;

function handle_key_token(pda_stack, token) {
    if (!token.string) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    ctx.current_key = token.value;
    ctx.current_nfa_states = [expect_colon_state];
    return true;
}

function handle_colon_token(pda_stack, token) {
    if (!token.colon) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    ctx.current_nfa_states = [expect_value_state];
    return true;
}

function handle_scalar_value(pda_stack, token) {
    if (!token.string && !token.number && !token.constant) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let scalar_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let scalar_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let scalar_node = new RainbowJsonNode(SCALAR_NODE_TYPE, scalar_key, scalar_index, new Position(token.line_num, token.position));
    scalar_node.end_position = new Position(token.line_num, token.position + token.value.length);
    scalar_node.value = token.value;
    ctx.node.children.push(scalar_node);
    
    if (ctx.node.node_type === OBJECT_NODE_TYPE) {
        ctx.current_nfa_states = [expect_comma_state, expect_object_end_state];
    } else {
        ctx.current_nfa_states = [expect_comma_state, expect_array_end_state];
    }
    return true;
}

function handle_open_brace(pda_stack, token) {
    if (!token.brace_open) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let child_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let child_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let child_node = new RainbowJsonNode(OBJECT_NODE_TYPE, child_key, child_index, new Position(token.line_num, token.position));
    ctx.node.children.push(child_node);
    
    if (ctx.node.node_type === OBJECT_NODE_TYPE) {
        ctx.current_nfa_states = [expect_comma_state, expect_object_end_state];
    } else {
        ctx.current_nfa_states = [expect_comma_state, expect_array_end_state];
    }
    
    let new_frame = new PDAStackFrame(child_node);
    new_frame.current_nfa_states = [expect_key_state, expect_object_end_state];
    pda_stack.push(new_frame);
    return true;
}

function handle_open_bracket(pda_stack, token) {
    if (!token.bracket_open) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let child_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let child_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let child_node = new RainbowJsonNode(ARRAY_NODE_TYPE, child_key, child_index, new Position(token.line_num, token.position));
    ctx.node.children.push(child_node);
    
    if (ctx.node.node_type === OBJECT_NODE_TYPE) {
        ctx.current_nfa_states = [expect_comma_state, expect_object_end_state];
    } else {
        ctx.current_nfa_states = [expect_comma_state, expect_array_end_state];
    }
    
    let new_frame = new PDAStackFrame(child_node);
    new_frame.current_nfa_states = [expect_value_state, expect_array_end_state];
    pda_stack.push(new_frame);
    return true;
}

function handle_comma(pda_stack, token) {
    if (!token.comma) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    if (ctx.node.node_type === OBJECT_NODE_TYPE) {
        ctx.current_nfa_states = [expect_key_state];
    } else {
        ctx.current_array_index += 1;
        ctx.current_nfa_states = [expect_value_state];
    }
    return true;
}

function handle_object_end(pda_stack, token) {
    if (!token.brace_close) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    if (ctx.node.node_type !== OBJECT_NODE_TYPE) {
        return false;
    }
    ctx.node.end_position = new Position(token.line_num, token.position);
    pda_stack.pop();
    return true;
}

function handle_array_end(pda_stack, token) {
    if (!token.bracket_close) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    if (ctx.node.node_type !== ARRAY_NODE_TYPE) {
        return false;
    }
    ctx.node.end_position = new Position(token.line_num, token.position);
    pda_stack.pop();
    return true;
}

function handle_value(pda_stack, token) {
    return handle_scalar_value(pda_stack, token) || handle_open_brace(pda_stack, token) || handle_open_bracket(pda_stack, token);
}

// Automata states
expect_key_state = new AutomataState(handle_key_token, 'string key');
expect_colon_state = new AutomataState(handle_colon_token, 'colon');
expect_value_state = new AutomataState(handle_value, 'value');
expect_comma_state = new AutomataState(handle_comma, 'comma');
expect_object_end_state = new AutomataState(handle_object_end, 'closing brace');
expect_array_end_state = new AutomataState(handle_array_end, 'closing bracket');

function generate_error_message(nfa_states) {
    let expected_parts = nfa_states.map(state => state.error_string);
    if (expected_parts.length === 1) {
        return `Expected ${expected_parts[0]}`;
    }
    let last = expected_parts.pop();
    return `Expected ${expected_parts.join(', ')} or ${last}`;
}

function consume_json_record(tokens, token_idx) {
    if (token_idx >= tokens.length) {
        return [null, token_idx];
    }
    
    let start_token = tokens[token_idx];
    if (!start_token.isContainerOpen()) {
        throw new JsonSyntaxError(`Expected '{' or '[', got "${start_token.value}"`, start_token.line_num, start_token.position);
    }
    
    let root_node_type = start_token.brace_open ? OBJECT_NODE_TYPE : ARRAY_NODE_TYPE;
    let root = new RainbowJsonNode(root_node_type, null, null, new Position(start_token.line_num, start_token.position));
    
    let pda_stack = [new PDAStackFrame(root)];
    if (root_node_type === OBJECT_NODE_TYPE) {
        pda_stack[0].current_nfa_states = [expect_key_state, expect_object_end_state];
    } else {
        pda_stack[0].current_nfa_states = [expect_value_state, expect_array_end_state];
    }
    
    token_idx += 1;
    
    while (token_idx < tokens.length && pda_stack.length > 0) {
        let token = tokens[token_idx];
        let ctx = pda_stack[pda_stack.length - 1];
        
        let handled = false;
        for (let state of ctx.current_nfa_states) {
            if (state.handler_function(pda_stack, token)) {
                handled = true;
                break;
            }
        }
        
        if (!handled) {
            let error_msg = generate_error_message(ctx.current_nfa_states);
            throw new JsonSyntaxError(`${error_msg}, got "${token.value}"`, token.line_num, token.position);
        }
        
        token_idx += 1;
    }
    
    if (pda_stack.length > 0) {
        throw new JsonIncompleteError(`Unclosed brackets at end of input`);
    }
    
    return [root, token_idx];
}



class ObjectGroupStackFrame {
    constructor(start_token) {
        this.start_token = start_token;
        this.complete_children = [];
    }
}


function group_tokens_into_full_object_groups(tokens) {
    // In the generic case we can have some trailing lines and some starting lines with incomplete objects.
    // But these first and last incomplete objects can have some child objects fully complete - we need to add those.
    // So essentially we need to find all complete objects, without sub-objects.
    // We also need to store relative levels of the complete objects, but they are not guaranteed to be absolute.
    // These levels should be relative to the current stack depth of opening brackets behind, including unbalanced or closing brackets ahead including unbalanced.
    //     {      // a
    //         {}  // - skip, subobject of a complete object a.
    //     }
    //     {   }   // b
    //   }
    //   [   ]     // c
    //   {
    //      {  {}  }  // d
    //      {   }  // e
    let result = [];
    let stack = [];
    for (let token of tokens) {
        if (!token.isContainerDelim())
            continue;

    }
    return result;
}


function parse_json_objects(lines, line_nums) {
    // Using first unindented container line to start parsing is a hack, but it should probably work OK in practice.
    // This can be fixed later.
    let tokens = [];
    for (let i = 0; i < lines.length; i++) {
        tokenize_json_line_in_place(lines[i], line_nums[i], tokens);
    }
    let token_object_groups = group_tokens_into_full_object_groups(tokens);
    let records = [];
    for (let token_object_group of token_object_groups) {
        let [current_record, token_idx] = consume_json_record(token_object_group.tokens, 0);
        // TODO make sure token_idx equals to group length.
        current_record.relative_depth = token_object_group.relative_depth;
        records.push(current_record);
    }
    return records;
}

module.exports = { tokenize_json_line, parse_json_objects, JsonTokenizerError, JsonSyntaxError, JsonIncompleteError };