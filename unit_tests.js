// Import the tokenize_line function
const { tokenize_json_line, parse_json_objects } = require('./json_parse.js');

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
    assert(result[0].string, 'Expected string attribute to be true');
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
    assert(result[0].number, 'Expected number attribute to be true');
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
    assert(result[0].constant, 'Expected constant attribute to be true');
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
    assert(result[0].brace_open, 'Expected brace_open attribute to be true');
});

test('BraceClose token', () => {
    const result = tokenize_json_line('}');
    assert(result[0].brace_close, 'Expected brace_close attribute to be true');
});

test('BracketOpen token', () => {
    const result = tokenize_json_line('[');
    assert(result[0].bracket_open, 'Expected bracket_open attribute to be true');
});

test('BracketClose token', () => {
    const result = tokenize_json_line(']');
    assert(result[0].bracket_close, 'Expected bracket_close attribute to be true');
});

test('Colon token', () => {
    const result = tokenize_json_line(':');
    assert(result[0].colon, 'Expected colon attribute to be true');
});

test('Comma token', () => {
    const result = tokenize_json_line(',');
    assert(result[0].comma, 'Expected comma attribute to be true');
});

test('Simple object structure', () => {
    const result = tokenize_json_line('{"key": "value"}');
    assert(result.length === 5, 'Expected 5 tokens');
    assert(result[0].brace_open, 'Expected brace_open');
    assert(result[1].string, 'Expected string');
    assert(result[2].colon, 'Expected colon');
    assert(result[3].string, 'Expected string');
    assert(result[4].brace_close, 'Expected brace_close');
});

test('Simple array structure', () => {
    const result = tokenize_json_line('[1, 2, 3]');
    assert(result.length === 7, 'Expected 7 tokens');
    assert(result[0].bracket_open, 'Expected bracket_open');
    assert(result[1].number, 'Expected number');
    assert(result[2].comma, 'Expected comma');
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

// Parse JSON objects tests
console.log('\n\nRunning parse_json_objects tests...\n');

test('Parse empty object', () => {
    const result = parse_json_objects(['{}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].node_type === 'OBJECT', 'Expected OBJECT type');
    assert(result[0].children.length === 0, 'Expected no children');
});

test('Parse empty array', () => {
    const result = parse_json_objects(['[]'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].node_type === 'ARRAY', 'Expected ARRAY type');
    assert(result[0].children.length === 0, 'Expected no children');
});

test('Parse simple object with one key-value', () => {
    const result = parse_json_objects(['{"name": "John"}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 1, 'Expected 1 child');
    assert(result[0].children[0].parent_key === '"name"', 'Expected correct key');
    assert(result[0].children[0].value === '"John"', 'Expected correct value');
});

test('Parse object with multiple keys', () => {
    const result = parse_json_objects(['{"name": "John", "age": 30, "active": true}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 3, 'Expected 3 children');
    assert(result[0].children[0].parent_key === '"name"', 'Expected name key');
    assert(result[0].children[1].parent_key === '"age"', 'Expected age key');
    assert(result[0].children[2].parent_key === '"active"', 'Expected active key');
});

test('Parse simple array with scalars', () => {
    const result = parse_json_objects(['[1, 2, 3]'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 3, 'Expected 3 children');
    assert(result[0].children[0].parent_array_index === 0, 'Expected index 0');
    assert(result[0].children[1].parent_array_index === 1, 'Expected index 1');
    assert(result[0].children[2].parent_array_index === 2, 'Expected index 2');
    assert(result[0].children[0].value === '1', 'Expected value 1');
});

test('Parse nested object', () => {
    const result = parse_json_objects(['{"person": {"name": "John", "age": 30}}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 1, 'Expected 1 child');
    assert(result[0].children[0].node_type === 'OBJECT', 'Expected nested OBJECT');
    assert(result[0].children[0].children.length === 2, 'Expected 2 grandchildren');
});

test('Parse nested array', () => {
    const result = parse_json_objects(['[[1, 2], [3, 4]]'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 2, 'Expected 2 children');
    assert(result[0].children[0].node_type === 'ARRAY', 'Expected nested ARRAY');
    assert(result[0].children[0].children.length === 2, 'Expected 2 elements in first array');
});

test('Parse array of objects', () => {
    const result = parse_json_objects(['[{"id": 1}, {"id": 2}]'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children.length === 2, 'Expected 2 children');
    assert(result[0].children[0].node_type === 'OBJECT', 'Expected OBJECT at index 0');
    assert(result[0].children[1].node_type === 'OBJECT', 'Expected OBJECT at index 1');
});

test('Parse object with array value', () => {
    const result = parse_json_objects(['{"tags": ["red", "blue"]}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    assert(result[0].children[0].node_type === 'ARRAY', 'Expected ARRAY value');
    assert(result[0].children[0].children.length === 2, 'Expected 2 array elements');
});

test('Parse multiple objects on separate lines', () => {
    const result = parse_json_objects(['{"id": 1}', '{"id": 2}'], [1, 2]);
    assert(result.length === 2, 'Expected 2 records');
    assert(result[0].children[0].value === '1', 'Expected id 1');
    assert(result[1].children[0].value === '2', 'Expected id 2');
});

test('Parse object with all scalar types', () => {
    const result = parse_json_objects(['{"str": "text", "num": 42, "bool": true, "null": null}'], [1]);
    assert(result[0].children.length === 4, 'Expected 4 children');
    assert(result[0].children[0].value === '"text"', 'Expected string value');
    assert(result[0].children[1].value === '42', 'Expected number value');
    assert(result[0].children[2].value === 'true', 'Expected boolean value');
    assert(result[0].children[3].value === 'null', 'Expected null value');
});

test('Parse deeply nested structure', () => {
    const result = parse_json_objects(['{"a": {"b": {"c": {"d": 1}}}}'], [1]);
    assert(result.length === 1, 'Expected 1 record');
    let node = result[0].children[0];
    assert(node.node_type === 'OBJECT', 'Level 1: Expected OBJECT');
    node = node.children[0];
    assert(node.node_type === 'OBJECT', 'Level 2: Expected OBJECT');
    node = node.children[0];
    assert(node.node_type === 'OBJECT', 'Level 3: Expected OBJECT');
    node = node.children[0];
    assert(node.node_type === 'SCALAR', 'Level 4: Expected SCALAR');
    assert(node.value === '1', 'Expected value 1');
});

test('Parse with line numbers', () => {
    const result = parse_json_objects(['{"key": "value"}'], [42]);
    assert(result[0].start_position.line === 42, 'Expected line number 42');
});

test('Parse mixed valid and invalid content', () => {
    const result = parse_json_objects(['garbage', '{"valid": 1}', 'more garbage'], [1, 2, 3]);
    assert(result.length === 1, 'Expected 1 valid record');
    assert(result[0].children[0].value === '1', 'Expected parsed valid object');
});

test('Error on unclosed object', () => {
    assertThrows(() => parse_json_objects(['{"key": "value"'], [1]), 'Should throw on unclosed object');
});

test('Error on unclosed array', () => {
    assertThrows(() => parse_json_objects(['[1, 2, 3'], [1]), 'Should throw on unclosed array');
});

test('Error on missing colon', () => {
    assertThrows(() => parse_json_objects(['{"key" "value"}'], [1]), 'Should throw on missing colon');
});

test('Error on missing comma in object', () => {
    assertThrows(() => parse_json_objects(['{"a": 1 "b": 2}'], [1]), 'Should throw on missing comma');
});

test('Error on missing comma in array', () => {
    assertThrows(() => parse_json_objects(['[1 2 3]'], [1]), 'Should throw on missing comma in array');
});

test('Error on trailing comma in object', () => {
    assertThrows(() => parse_json_objects(['{"key": "value",}'], [1]), 'Should throw on trailing comma');
});

test('Error on mismatched brackets', () => {
    assertThrows(() => parse_json_objects(['{"key": [1, 2}'], [1]), 'Should throw on mismatched brackets');
});

test('Parse empty object in array', () => {
    const result = parse_json_objects(['[{}]'], [1]);
    assert(result[0].children[0].node_type === 'OBJECT', 'Expected empty OBJECT in array');
    assert(result[0].children[0].children.length === 0, 'Expected no children in empty object');
});

test('Parse empty array in object', () => {
    const result = parse_json_objects(['{"arr": []}'], [1]);
    assert(result[0].children[0].node_type === 'ARRAY', 'Expected empty ARRAY');
    assert(result[0].children[0].children.length === 0, 'Expected no children in empty array');
});

console.log('\nAll parse_json_objects tests completed!');
