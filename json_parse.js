// Json tokens can't span multiple lines so we can tokenize them on line-by-line basis which is nice.
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
                let token = {
                    value: value,
                    line_num: line_num,
                    position: cursor,
                }
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
                if (token.punctuation) {
                    switch (value) {
                        case '{': token.brace_open = true; break;
                        case '}': token.brace_close = true; break;
                        case '[': token.bracket_open = true; break;
                        case ']': token.bracket_close = true; break;
                        case ':': token.colon = true; break;
                        case ',': token.comma = true; break;
                    }
                }

                dst_tokens.push(token);
            }
            // Advance cursor by the length of the matched string
            cursor += value.length;
            matchFound = true;
            break; // Stop checking patterns for this position
        }

        if (!matchFound) {
            throw new Error(`Unexpected character at position ${cursor}: "${line[cursor]}"`);
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

// Parser states
const STATE_EXPECT_KEY = 'EXPECT_KEY';
const STATE_EXPECT_COLON = 'EXPECT_COLON';
const STATE_EXPECT_VALUE = 'EXPECT_VALUE';
const STATE_EXPECT_COMMA_OR_END = 'EXPECT_COMMA_OR_END';

// Parser actions
const ACTION_ADVANCE = 'advance';
const ACTION_PUSH_CONTAINER = 'push_container';
const ACTION_ADD_SCALAR = 'add_scalar';
const ACTION_POP_CONTAINER = 'pop_container';
const ACTION_ERROR = 'error';

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

function consume_record(tokens, token_idx) {
    if (token_idx >= tokens.length) {
        return [null, token_idx];
    }
    let start_token = tokens[token_idx];
    if (!start_token.brace_open && !start_token.bracket_open) {
        return [null, token_idx];
    }

    let root_node_type = start_token.brace_open ? OBJECT_NODE_TYPE : ARRAY_NODE_TYPE;
    let root = new RainbowJsonNode(root_node_type, null, null, new Position(start_token.line_num, start_token.position));

    // Stack entries: { node, state, array_index, current_key }
    let stack = [{
        node: root,
        state: root_node_type === OBJECT_NODE_TYPE ? STATE_EXPECT_KEY : STATE_EXPECT_VALUE,
        array_index: 0,
        current_key: null
    }];

    token_idx += 1;

    while (token_idx < tokens.length && stack.length > 0) {
        let token = tokens[token_idx];
        let ctx = stack[stack.length - 1];

        // Handle empty containers
        if ((token.brace_close || token.bracket_close) &&
            (ctx.state === STATE_EXPECT_KEY || ctx.state === STATE_EXPECT_VALUE) &&
            ctx.node.children.length === 0) {
            ctx.state = STATE_EXPECT_COMMA_OR_END;
        }

        let transition = STATE_TRANSITIONS[ctx.state];
        let handler = transition(token, ctx);

        switch (handler.action) {
            case ACTION_ADVANCE:
                token_idx += 1;
                ctx.state = handler.next_state;
                break;

            case ACTION_PUSH_CONTAINER:
                let child_type = token.brace_open ? OBJECT_NODE_TYPE : ARRAY_NODE_TYPE;
                let child_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
                let child_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.array_index : null;
                let child_node = new RainbowJsonNode(child_type, child_key, child_index, new Position(token.line_num, token.position));
                ctx.node.children.push(child_node);
                ctx.state = STATE_EXPECT_COMMA_OR_END;
                stack.push({
                    node: child_node,
                    state: child_type === OBJECT_NODE_TYPE ? STATE_EXPECT_KEY : STATE_EXPECT_VALUE,
                    array_index: 0,
                    current_key: null
                });
                token_idx += 1;
                break;

            case ACTION_ADD_SCALAR:
                let scalar_key = ctx.node.node_type === OBJECT_NODE_TYPE ? ctx.current_key : null;
                let scalar_index = ctx.node.node_type === ARRAY_NODE_TYPE ? ctx.array_index : null;
                let scalar_node = new RainbowJsonNode(SCALAR_NODE_TYPE, scalar_key, scalar_index, new Position(token.line_num, token.position));
                scalar_node.end_position = new Position(token.line_num, token.position + token.value.length);
                scalar_node.value = token.value;
                ctx.node.children.push(scalar_node);
                ctx.state = STATE_EXPECT_COMMA_OR_END;
                token_idx += 1;
                break;

            case ACTION_POP_CONTAINER:
                ctx.node.end_position = new Position(token.line_num, token.position);
                stack.pop();
                token_idx += 1;
                break;

            case ACTION_ERROR:
                throw new Error(`${handler.message} at line ${token.line_num}, position ${token.position}`);
        }
    }

    if (stack.length > 0) {
        throw new Error(`Unclosed brackets at end of input`);
    }

    return [root, token_idx];
}

const STATE_TRANSITIONS = {
    [STATE_EXPECT_KEY]: (token, ctx) => {
        if (token.string) {
            ctx.current_key = token.value;
            return { action: ACTION_ADVANCE, next_state: STATE_EXPECT_COLON };
        }
        return { action: ACTION_ERROR, message: 'Expected string key' };
    },

    [STATE_EXPECT_COLON]: (token, ctx) => {
        if (token.colon) {
            return { action: ACTION_ADVANCE, next_state: STATE_EXPECT_VALUE };
        }
        return { action: ACTION_ERROR, message: 'Expected colon' };
    },

    [STATE_EXPECT_VALUE]: (token, ctx) => {
        if (token.brace_open || token.bracket_open) {
            return { action: ACTION_PUSH_CONTAINER };
        }
        if (token.string || token.number || token.constant) {
            return { action: ACTION_ADD_SCALAR };
        }
        return { action: ACTION_ERROR, message: 'Expected value' };
    },

    [STATE_EXPECT_COMMA_OR_END]: (token, ctx) => {
        if (token.comma) {
            if (ctx.node.node_type === OBJECT_NODE_TYPE) {
                return { action: ACTION_ADVANCE, next_state: STATE_EXPECT_KEY };
            } else {
                ctx.array_index += 1;
                return { action: ACTION_ADVANCE, next_state: STATE_EXPECT_VALUE };
            }
        }
        let is_matching_close = (ctx.node.node_type === OBJECT_NODE_TYPE && token.brace_close) ||
                                (ctx.node.node_type === ARRAY_NODE_TYPE && token.bracket_close);
        if (is_matching_close) {
            return { action: ACTION_POP_CONTAINER };
        }
        return { action: ACTION_ERROR, message: 'Expected comma or closing bracket' };
    }
};

function parse_json_objects(lines, line_nums) {
    let tokens = [];
    for (let i = 0; i < lines.length; i++) {
        tokenize_json_line_in_place(lines[i], line_nums[i], tokens);
    }
    let records = [];
    let previous_record = null;
    let token_idx = 0;
    while (token_idx < tokens.length) {
        if (tokens[token_idx].brace_open || tokens[token_idx].bracket_open) {
            if (previous_record) {
                records.push(previous_record);
            }
            [previous_record, token_idx] = consume_record(tokens, token_idx);
        } else {
            previous_record = null;
        }
        token_idx += 1;
    }
    if (previous_record) {
        records.push(previous_record);
    }
    return records;
}

module.exports = { tokenize_json_line };