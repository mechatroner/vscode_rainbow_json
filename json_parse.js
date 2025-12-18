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
// We can also have the same array elements

// Object children have keys, Array children have indexes.

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
        this.children = [];
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
    let root = new RainbowJsonNode(root_node_type, /*parent_key=*/null, /*parent_array_index=*/null, new Position(start_token.line_num, start_token.position));
    let braces_stack = []; // Do we really need this?
    braces_stack.push(start_token);
    token_idx += 1;
    while (braces_stack.length) {

    }
    return [root, token_idx];
}


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