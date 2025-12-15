
// Json tokens can't span multiple lines so we can tokenize them on line-by-line basis which is nice.
function tokenize_line (line) {
const tokens = [];
    let cursor = 0;
    const length = line.length;

    // Define token patterns using the 'y' (sticky) flag.
    // The 'y' flag ensures matches only occur exactly at .lastIndex
    const patterns = [
        { type: 'Whitespace', regex: /\s+/y },
        { type: 'Constant', regex: /true|false|null/y },
        { type: 'String', regex: /"(?:[^"\\]|\\.)*"/y },
        // Number: Optional negative, followed by 0 or 1-9+digits, optional fraction, optional exponent
        { type: 'Number', regex: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y },
        { type: 'Punctuation',regex: /[{}[\]:,]/y }
    ];

    while (cursor < length) {
        let matchFound = false;

        for (const { type, regex } of patterns) {
            // Set the regex cursor to the current position in the string
            regex.lastIndex = cursor;
            
            const match = regex.exec(line);
            
            if (match) {
                const value = match[0];
                
                // We skip adding Whitespace to the output, but we must advance the cursor
                if (type !== 'Whitespace') {
                    // Determine specific punctuation type for clearer output
                    let tokenType = type;
                    if (tokenType === 'Punctuation') {
                        switch (value) {
                            case '{': tokenType = 'BraceOpen'; break;
                            case '}': tokenType = 'BraceClose'; break;
                            case '[': tokenType = 'BracketOpen'; break;
                            case ']': tokenType = 'BracketClose'; break;
                            case ':': tokenType = 'Colon'; break;
                            case ',': tokenType = 'Comma'; break;
                        }
                    }

                    tokens.push({
                        token_type: tokenType,
                        value: value,
                        position: cursor
                    });
                }

                // Advance cursor by the length of the matched string
                cursor += value.length;
                matchFound = true;
                break; // Stop checking patterns for this position
            }
        }

        if (!matchFound) {
            throw new Error(`Unexpected character at position ${cursor}: "${line[cursor]}"`);
        }
    }

    return tokens;
}