// Json tokens can't span multiple lines so we can tokenize them on line-by-line basis which is nice.

/**
 * @param {boolean} condition
 * @param {string} message
 * @throws {Error}
 */
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

// Custom error types
class JsonTokenizerError extends Error {
    /**
     * @param {string} message
     * @param {number} line_num
     * @param {number} position
     */
    constructor(message, line_num, position) {
        super(message);
        this.name = 'JsonTokenizerError';
        this.line_num = line_num;
        this.position = position;
    }
}

class JsonSyntaxError extends Error {
    /**
     * @param {string} message
     * @param {number} line_num
     * @param {number} position
     */
    constructor(message, line_num, position) {
        super(message);
        this.name = 'JsonSyntaxError';
        this.line_num = line_num;
        this.position = position;
    }
}

class JsonIncompleteError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'JsonIncompleteError';
    }
}

class JsonToken {
    /**
     * @param {string} value
     * @param {number} line_num
     * @param {number} position
     */
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

    /**
     * @param {JsonToken} openToken
     */
    isMatchingClose(openToken) {
        return (this.brace_close && openToken.brace_open) || 
               (this.bracket_close && openToken.bracket_open);
    }
}

/**
 * @param {string} line
 * @param {number} line_num
 * @param {JsonToken[]} dst_tokens
 * @throws {JsonTokenizerError}
 */
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

/**
 * @param {string} line
 * @param {number|null} [line_num=null]
 * @returns {JsonToken[]}
 */
function tokenize_json_line(line, line_num=null) {
    tokens = []
    tokenize_json_line_in_place(line, line_num, tokens);
    return tokens;
}


class Position {
    /**
     * @param {number} line
     * @param {number} character
     */
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    /**
     * @param {Position} start_position
     * @param {Position} end_position
     */
    constructor(start_position, end_position) {
        this.start_position = start_position;
        this.end_position = end_position;
    }

    // TODO add unit tests.
    contains(position) {
        if (position.line < this.start_position.line || position.line > this.end_position.line) {
            return false;
        }
        if (position.line === this.start_position.line && position.character < this.start_position.character) {
            return false;
        }
        if (position.line === this.end_position.line && position.character > this.end_position.character) {
            return false;
        }
        return true;
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
    /**
     * @param {string} node_type
     * @param {string|null} parent_key
     * @param {Position|null} parent_key_position
     * @param {number|null} parent_array_index
     * @param {Position} start_position
     */
    constructor(node_type, parent_key, parent_key_position, parent_array_index, start_position) {
        this.node_type = node_type;
        this.parent_key = parent_key; // Key can be null for array or for the root node.
        this.parent_key_position = parent_key_position;
        this.parent_array_index = parent_array_index; // null value means it is not an array element but was mapped directly by the key.
        this.start_position = start_position;
        this.end_position = null;
        this.children = []; // For container nodes.
        this.value = null; // For scalar nodes.
        this.relative_depth = null; // Only set for root nodes.
    }

    getValueRange() {
        if (this.start_position === null || this.end_position === null) {
            return null;
        }
        return new Range(this.start_position, this.end_position);
    }

    getParentKeyRange() {
        if (this.parent_key_position === null || this.parent_key === null) {
            return null;
        }
        return new Range(this.parent_key_position, new Position(this.parent_key_position.line, this.parent_key_position.character + this.parent_key.length));
    }
}

class PDAStackFrame {
    /**
     * @param {RainbowJsonNode} node
     */
    constructor(node) {
        this.node = node;
        this.current_nfa_states = [];
        this.current_array_index = 0;
        this.current_key = null;
        this.current_key_position = null;
    }
}

class AutomataState {
    /**
     * @param {function(PDAStackFrame[], JsonToken): boolean} handler_function
     * @param {string} error_string
     */
    constructor(handler_function, error_string) {
        this.handler_function = handler_function;
        this.error_string = error_string;
    }
}

// Forward declarations - will be defined after all handlers
let expect_key_state, expect_colon_state, expect_value_state, expect_comma_state, expect_object_end_state, expect_array_end_state;

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
function handle_key_token(pda_stack, token) {
    if (!token.string) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    ctx.current_key = token.value;
    ctx.current_key_position = new Position(token.line_num, token.position);
    ctx.current_nfa_states = [expect_colon_state];
    return true;
}

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
function handle_colon_token(pda_stack, token) {
    if (!token.colon) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    ctx.current_nfa_states = [expect_value_state];
    return true;
}

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
function handle_scalar_value(pda_stack, token) {
    if (!token.string && !token.number && !token.constant) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let scalar_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let scalar_key_position = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key_position : null;
    let scalar_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let scalar_node = new RainbowJsonNode(SCALAR_NODE_TYPE, scalar_key, scalar_key_position, scalar_index, new Position(token.line_num, token.position));
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
function handle_open_brace(pda_stack, token) {
    if (!token.brace_open) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let child_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let child_key_position = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key_position : null;
    let child_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let child_node = new RainbowJsonNode(OBJECT_NODE_TYPE, child_key, child_key_position, child_index, new Position(token.line_num, token.position));
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
function handle_open_bracket(pda_stack, token) {
    if (!token.bracket_open) {
        return false;
    }
    let ctx = pda_stack[pda_stack.length - 1];
    let child_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
    let child_key_position = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key_position : null;
    let child_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.current_array_index : null;
    let child_node = new RainbowJsonNode(ARRAY_NODE_TYPE, child_key, child_key_position, child_index, new Position(token.line_num, token.position));
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
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

/**
 * @param {PDAStackFrame[]} pda_stack
 * @param {JsonToken} token
 */
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

/**
 * @param {JsonToken[]} tokens
 * @param {number} token_idx
 * @returns {[RainbowJsonNode|null, number]}
 * @throws {JsonSyntaxError|JsonIncompleteError}
 */
function consume_json_record(tokens, token_idx) {
    if (token_idx >= tokens.length) {
        return [null, token_idx];
    }
    
    let start_token = tokens[token_idx];
    if (!start_token.isContainerOpen()) {
        throw new JsonSyntaxError(`Expected '{' or '[', got "${start_token.value}"`, start_token.line_num, start_token.position);
    }
    
    let root_node_type = start_token.brace_open ? OBJECT_NODE_TYPE : ARRAY_NODE_TYPE;
    let root = new RainbowJsonNode(root_node_type, /*parent_key=*/null, /*parent_key_position=*/null, /*parent_array_index=*/null, new Position(start_token.line_num, start_token.position));
    
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



class CompleteObjectTokenGroup {
    /**
     * @param {number} first_token_idx
     * @param {number} last_token_idx
     * @param {number} relative_depth
     */
    constructor(first_token_idx, last_token_idx, relative_depth) {
        this.first_token_idx = first_token_idx;
        this.last_token_idx = last_token_idx;
        this.relative_depth = relative_depth;
    }
}

class ObjectGroupStackFrame {
    /**
     * @param {number} first_token_idx
     */
    constructor(first_token_idx) {
        this.first_token_idx = first_token_idx;
        this.complete_children_groups = [];
    }
}

/**
 * @param {JsonToken[]} tokens
 * @returns {CompleteObjectTokenGroup[]}
 * @throws {JsonSyntaxError}
 */
function group_tokens_into_full_object_groups(tokens) {
    // In the generic case we can have some trailing lines and some starting lines with incomplete objects.
    // But these first and last incomplete objects can have some child objects fully complete - we need to add those.
    // So essentially we need to find all complete objects, without sub-objects.
    // We also need to store relative levels of the complete objects, but they are not guaranteed to be absolute.
    // These levels should be relative to the current stack depth of opening brackets behind, including unbalanced or closing brackets ahead including unbalanced.
    //     {      // a
    //         {}  // - skip, subobject of a complete object a.
    //     },
    //     {   }   // b
    //   },
    //   [   ],     // c
    //   {
    //      {
    //         {}  d
    let result = [];
    let stack = [];
    for (let token_idx = 0; token_idx < tokens.length; token_idx++) {
        let token = tokens[token_idx];
        if (!token.isContainerDelim())
            continue;
        if (token.isContainerOpen()) {
            stack.push(new ObjectGroupStackFrame(token_idx));
            continue;
        }
        // Token is container close.
        if (stack.length === 0) {
            // Update depths of existing groups.
            // TODO this is an enefficient way to do this, potentially quadratic complexity, find a better to update depths and apply it once at the end.
            for (let group of result) {
                group.relative_depth += 1;
            }
            continue;
        }
        let top = stack[stack.length - 1];
        if (!token.isMatchingClose(tokens[top.first_token_idx])) {
            throw new JsonSyntaxError(`Mismatched closing token "${token.value}"`, token.line_num, token.position);
        }
        let last_complete_object = new CompleteObjectTokenGroup(top.first_token_idx, token_idx, stack.length - 1);
        stack.pop();
        if (stack.length > 0) {
            stack[stack.length - 1].complete_children_groups.push(last_complete_object);
        } else {
            result.push(last_complete_object);
        }
    }
    for (let ogsf of stack) {
        for (let last_complete_object of ogsf.complete_children_groups) {
            result.push(last_complete_object);
        }
    }

    return result;
}


/**
 * @param {string[]} lines
 * @param {number[]} line_nums
 * @returns {RainbowJsonNode[]}
 * @throws {JsonTokenizerError|JsonSyntaxError}
 */
function parse_json_objects(lines, line_nums) {
    // Using first unindented container line to start parsing is a hack, but it should probably work OK in practice.
    // This can be fixed later.
    // TODO we can probably do all 3 steps in a single pass. Or at least do them in 2 steps.
    let tokens = [];
    for (let i = 0; i < lines.length; i++) {
        tokenize_json_line_in_place(lines[i], line_nums[i], tokens);
    }
    let token_object_groups = group_tokens_into_full_object_groups(tokens);
    let records = [];
    for (let token_object_group of token_object_groups) {
        let [current_record, token_idx] = consume_json_record(tokens, token_object_group.first_token_idx);
        assert(token_idx === token_object_group.last_token_idx + 1, "Token index does not match expected last token index");
        current_record.relative_depth = token_object_group.relative_depth;
        records.push(current_record);
    }
    return records;
}

module.exports = { tokenize_json_line, parse_json_objects, JsonTokenizerError, JsonSyntaxError, JsonIncompleteError, RainbowJsonNode};