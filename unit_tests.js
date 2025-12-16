// Import the tokenize_line function
const { tokenize_line: tokenize_json_line } = require('./json_parse.js');

// Simple test runner
function assert(condition, message) {
    if (!condition) {
        throw new Error(`Assertion failed: ${message}`);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        throw new Error(`Expected function to throw: ${message}`);
    } catch (e) {
        if (e.message.startsWith('Expected function to throw')) {
            throw e;
        }
        // Expected error, test passes
    }
}

function test(name, fn) {
    try {
        fn();
        console.log(`OK: ${name}`);
    } catch (e) {
        console.error(`FAIL: ${name}`);
        console.error(`  ${e.message}`);
    }
}

// Run tests
console.log('Running tokenize_line tests...\n');

test('Empty string returns empty array', () => {
    const result = tokenize_json_line('');
    assert(result.length === 0, 'Expected empty array');
});

test('Whitespace only returns empty array', () => {
    const result = tokenize_json_line('   \t  ');
    assert(result.length === 0, 'Expected empty array');
});

test('String token', () => {
    const result = tokenize_json_line('"hello world"');
    assert(result.length === 1, 'Expected 1 token');
    assert(result[0].token_type === 'String', 'Expected String type');
    assert(result[0].value === '"hello world"', 'Expected correct value');
});

test('String with escaped characters', () => {
    const result = tokenize_json_line('"hello \\"world\\""');
    assert(result.length === 1, 'Expected 1 token');
    assert(result[0].value === '"hello \\"world\\""', 'Expected escaped quotes');
});

test('Integer number', () => {
    const result = tokenize_json_line('42');
    assert(result.length === 1, 'Expected 1 token');
    assert(result[0].token_type === 'Number', 'Expected Number type');
    assert(result[0].value === '42', 'Expected correct value');
});

test('Negative number', () => {
    const result = tokenize_json_line('-42');
    assert(result[0].value === '-42', 'Expected negative number');
});

test('Decimal number', () => {
    const result = tokenize_json_line('3.14159');
    assert(result[0].value === '3.14159', 'Expected decimal number');
});

test('Number with exponent', () => {
    const result = tokenize_json_line('1.23e-10');
    assert(result[0].value === '1.23e-10', 'Expected scientific notation');
});

test('Zero', () => {
    const result = tokenize_json_line('0');
    assert(result[0].value === '0', 'Expected zero');
});

test('Boolean true', () => {
    const result = tokenize_json_line('true');
    assert(result[0].token_type === 'Constant', 'Expected Constant type');
    assert(result[0].value === 'true', 'Expected true');
});

test('Boolean false', () => {
    const result = tokenize_json_line('false');
    assert(result[0].value === 'false', 'Expected false');
});

test('Null constant', () => {
    const result = tokenize_json_line('null');
    assert(result[0].value === 'null', 'Expected null');
});

test('BraceOpen token', () => {
    const result = tokenize_json_line('{');
    assert(result[0].token_type === 'BraceOpen', 'Expected BraceOpen');
});

test('BraceClose token', () => {
    const result = tokenize_json_line('}');
    assert(result[0].token_type === 'BraceClose', 'Expected BraceClose');
});

test('BracketOpen token', () => {
    const result = tokenize_json_line('[');
    assert(result[0].token_type === 'BracketOpen', 'Expected BracketOpen');
});

test('BracketClose token', () => {
    const result = tokenize_json_line(']');
    assert(result[0].token_type === 'BracketClose', 'Expected BracketClose');
});

test('Colon token', () => {
    const result = tokenize_json_line(':');
    assert(result[0].token_type === 'Colon', 'Expected Colon');
});

test('Comma token', () => {
    const result = tokenize_json_line(',');
    assert(result[0].token_type === 'Comma', 'Expected Comma');
});

test('Simple object structure', () => {
    const result = tokenize_json_line('{"key": "value"}');
    assert(result.length === 5, 'Expected 5 tokens');
    assert(result[0].token_type === 'BraceOpen', 'Expected BraceOpen');
    assert(result[1].token_type === 'String', 'Expected String');
    assert(result[2].token_type === 'Colon', 'Expected Colon');
    assert(result[3].token_type === 'String', 'Expected String');
    assert(result[4].token_type === 'BraceClose', 'Expected BraceClose');
});

test('Simple array structure', () => {
    const result = tokenize_json_line('[1, 2, 3]');
    assert(result.length === 7, 'Expected 7 tokens');
    assert(result[0].token_type === 'BracketOpen', 'Expected BracketOpen');
    assert(result[1].token_type === 'Number', 'Expected Number');
    assert(result[2].token_type === 'Comma', 'Expected Comma');
});

test('Mixed types', () => {
    const result = tokenize_json_line('[true, false, null, 42, "text"]');
    assert(result.length === 11, 'Expected 11 tokens');
    assert(result[1].value === 'true', 'Expected true');
    assert(result[3].value === 'false', 'Expected false');
    assert(result[5].value === 'null', 'Expected null');
    assert(result[7].value === '42', 'Expected 42');
    assert(result[9].value === '"text"', 'Expected text');
});

test('Whitespace handling', () => {
    const result = tokenize_json_line('  {  "key"  :  "value"  }  ');
    assert(result.length === 5, 'Expected 5 tokens (whitespace skipped)');
});

test('Token positions', () => {
    const result = tokenize_json_line('{"a": 1}');
    assert(result[0].position === 0, 'BraceOpen at position 0');
    assert(result[1].position === 1, 'String at position 1');
    assert(result[2].position === 4, 'Colon at position 4');
    assert(result[3].position === 6, 'Number at position 6');
    assert(result[4].position === 7, 'BraceClose at position 7');
});

test('Invalid character throws error', () => {
    assertThrows(() => tokenize_json_line('@'), 'Should throw on invalid character');
});

test('Invalid character in middle throws error', () => {
    assertThrows(() => tokenize_json_line('{"key"@ "value"}'), 'Should throw on @ character');
});

test('Unclosed string throws error', () => {
    assertThrows(() => tokenize_json_line('"unclosed'), 'Should throw on unclosed string');
});

console.log('\nTests completed!');
