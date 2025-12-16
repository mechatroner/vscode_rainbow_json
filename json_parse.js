// Json tokens can't span multiple lines so we can tokenize them on line-by-line basis which is nice.
function tokenize_json_line_in_place(line, dst_tokens) {
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
                    position: cursor                    
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

function tokenize_json_line (line) {
    tokens = []
    tokenize_json_line_in_place(line, tokens);
    return tokens;
}



function consume_record(tokens, token_idx) {

}


function parse_json_objects(lines) {
    let tokens = [];
    for (const line of lines) {
        tokenize_json_line_in_place(line, tokens);
    }
    let records = [];
    let previous_record = null;
    let token_idx = 0;
    while (token_idx < tokens.length) {
        if (tokens[token_idx].brace_open) {
            if (previous_record) {
                records.push(previous_record);
            }
            [previous_record, token_idx] = consume_record(tokens, token_idx);
        } else {
            previous_record = null;
        }
    }
    if (previous_record) {
        records.push(previous_record);
    }
    return records;
}

module.exports = { tokenize_json_line };