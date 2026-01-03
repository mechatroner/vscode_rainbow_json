// Import the tokenize_line function
const { tokenize_json_line, parse_json_objects, JsonTokenizerError, JsonSyntaxError, JsonIncompleteError } = require('./json_parse.js');

/**
 * @param {boolean} condition
 * @param {string} [message]
 * @throws {Error}
 */
function assert(condition, message) {
    if (!condition) {
        throw new Error(message ? `Assertion failed: ${message}` : 'Assertion failed');
    }
}

/**
 * @param {any} actual
 * @param {any} expected
 * @param {string} [message]
 * @throws {Error}
 */
function assertEquals(actual, expected, message) {
    if (actual !== expected) {
        const baseMsg = `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
        throw new Error(message ? `${message}: ${baseMsg}` : baseMsg);
    }
}

/**
 * @param {function(): void} fn
 * @param {string} [message]
 * @param {function|null} [expectedErrorType=null]
 * @throws {Error}
 */
function assertThrows(fn, message, expectedErrorType = null) {
    try {
        fn();
        throw new Error(message ? `Expected function to throw: ${message}` : 'Expected function to throw');
    } catch (e) {
        if (e.message.startsWith('Expected function to throw')) {
            throw e;
        }
        if (expectedErrorType && !(e instanceof expectedErrorType)) {
            throw new Error(`Expected ${expectedErrorType.name}, got ${e.constructor.name}${message ? `: ${message}` : ''}`);
        }
        // Expected error, test passes
    }
}

// Test registry
/** @type {{id: number, name: string, fn: function(): void}[]} */
const allTests = [];
/** @type {number} */
let testIdCounter = 1;

/**
 * @param {string} name
 * @param {function(): void} fn
 */
function test(name, fn) {
    const testId = testIdCounter++;
    allTests.push({ id: testId, name, fn });
}

/**
 * @param {number[]|null} [testIds=null]
 * @param {boolean} [rethrowOnFailure=false]
 */
function runTests(testIds = null, rethrowOnFailure = false) {
    let testsToRun = allTests;

    if (testIds && testIds.length > 0) {
        const idSet = new Set(testIds);
        testsToRun = allTests.filter(t => idSet.has(t.id));

        if (testsToRun.length === 0) {
            console.error('No tests found with the specified IDs');
            return;
        }
    }

    let passCount = 0;
    let failCount = 0;

    for (const { id, name, fn } of testsToRun) {
        try {
            fn();
            console.log(`OK [${id}]: ${name}`);
            passCount++;
        } catch (e) {
            console.error(`FAIL [${id}]: ${name}`);
            console.error(`  ${e.message}`);
            failCount++;
            if (rethrowOnFailure) {
                throw e;
            }
        }
    }

    console.log(`\nResults: ${passCount} passed, ${failCount} failed, ${testsToRun.length} total`);
}

/**
 * @returns {void}
 */
function listTests() {
    console.log('Available tests:\n');
    for (const { id, name } of allTests) {
        console.log(`  [${id}] ${name}`);
    }
    console.log(`\nTotal: ${allTests.length} tests`);
}

// Define all tests
console.log('Registering tests...\n');

// Tokenize tests
test('Empty string returns empty array', () => {
    const result = tokenize_json_line('');
    assertEquals(result.length, 0);
});

test('Whitespace only returns empty array', () => {
    const result = tokenize_json_line('   \t  ');
    assertEquals(result.length, 0);
});

test('String token', () => {
    const result = tokenize_json_line('"hello world"');
    assertEquals(result.length, 1);
    assert(result[0].string);
    assertEquals(result[0].value, '"hello world"');
});

test('String with escaped characters', () => {
    const result = tokenize_json_line('"hello \\"world\\""');
    assertEquals(result.length, 1);
    assertEquals(result[0].value, '"hello \\"world\\""');
});

test('Integer number', () => {
    const result = tokenize_json_line('42');
    assertEquals(result.length, 1);
    assert(result[0].number);
    assertEquals(result[0].value, '42');
});

test('Negative number', () => {
    const result = tokenize_json_line('-42');
    assertEquals(result[0].value, '-42');
});

test('Decimal number', () => {
    const result = tokenize_json_line('3.14159');
    assertEquals(result[0].value, '3.14159');
});

test('Number with exponent', () => {
    const result = tokenize_json_line('1.23e-10');
    assertEquals(result[0].value, '1.23e-10');
});

test('Zero', () => {
    const result = tokenize_json_line('0');
    assertEquals(result[0].value, '0');
});

test('Boolean true', () => {
    const result = tokenize_json_line('true');
    assert(result[0].constant);
    assertEquals(result[0].value, 'true');
});

test('Boolean false', () => {
    const result = tokenize_json_line('false');
    assertEquals(result[0].value, 'false');
});

test('Null constant', () => {
    const result = tokenize_json_line('null');
    assertEquals(result[0].value, 'null');
});

test('BraceOpen token', () => {
    const result = tokenize_json_line('{');
    assert(result[0].brace_open);
});

test('BraceClose token', () => {
    const result = tokenize_json_line('}');
    assert(result[0].brace_close);
});

test('BracketOpen token', () => {
    const result = tokenize_json_line('[');
    assert(result[0].bracket_open);
});

test('BracketClose token', () => {
    const result = tokenize_json_line(']');
    assert(result[0].bracket_close);
});

test('Colon token', () => {
    const result = tokenize_json_line(':');
    assert(result[0].colon);
});

test('Comma token', () => {
    const result = tokenize_json_line(',');
    assert(result[0].comma);
});

test('Simple object structure', () => {
    const result = tokenize_json_line('{"key": "value"}');
    assertEquals(result.length, 5);
    assert(result[0].brace_open);
    assert(result[1].string);
    assert(result[2].colon);
    assert(result[3].string);
    assert(result[4].brace_close);
});

test('Simple array structure', () => {
    const result = tokenize_json_line('[1, 2, 3]');
    assertEquals(result.length, 7);
    assert(result[0].bracket_open);
    assert(result[1].number);
    assert(result[2].comma);
});

test('Mixed types', () => {
    const result = tokenize_json_line('[true, false, null, 42, "text"]');
    assertEquals(result.length, 11);
    assertEquals(result[1].value, 'true');
    assertEquals(result[3].value, 'false');
    assertEquals(result[5].value, 'null');
    assertEquals(result[7].value, '42');
    assertEquals(result[9].value, '"text"');
});

test('Whitespace handling', () => {
    const result = tokenize_json_line('  {  "key"  :  "value"  }  ');
    assertEquals(result.length, 5);
});

test('Token positions', () => {
    const result = tokenize_json_line('{"a": 1}');
    assertEquals(result[0].position, 0);
    assertEquals(result[1].position, 1);
    assertEquals(result[2].position, 4);
    assertEquals(result[3].position, 6);
    assertEquals(result[4].position, 7);
});

test('Invalid character throws error', () => {
    assertThrows(() => tokenize_json_line('@'), 'Should throw on invalid character', JsonTokenizerError);
});

test('Invalid character in middle throws error', () => {
    assertThrows(() => tokenize_json_line('{"key"@ "value"}'), 'Should throw on @ character', JsonTokenizerError);
});

test('Unclosed string throws error', () => {
    assertThrows(() => tokenize_json_line('"unclosed'), 'Should throw on unclosed string', JsonTokenizerError);
});

// Parse JSON objects tests
test('Parse empty object', () => {
    const result = parse_json_objects(['{}'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].node_type, 'OBJECT');
    assertEquals(result[0].children.length, 0);
});

test('Parse empty array', () => {
    const result = parse_json_objects(['[]'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].node_type, 'ARRAY');
    assertEquals(result[0].children.length, 0);
});

test('Parse simple object with one key-value', () => {
    const result = parse_json_objects(['{"name": "John"}'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 1);
    assertEquals(result[0].children[0].parent_key, '"name"');
    assertEquals(result[0].children[0].value, '"John"');
});

test('Parse object with multiple keys', () => {
    const result = parse_json_objects(['{"name": "John", "age": 30, "active": true}'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 3);
    assertEquals(result[0].children[0].parent_key, '"name"');
    assertEquals(result[0].children[1].parent_key, '"age"');
    assertEquals(result[0].children[2].parent_key, '"active"');
});

test('Parse simple array with scalars', () => {
    const result = parse_json_objects(['[1, 2, 3]'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 3);
    assertEquals(result[0].children[0].parent_array_index, 0);
    assertEquals(result[0].children[1].parent_array_index, 1);
    assertEquals(result[0].children[2].parent_array_index, 2);
    assertEquals(result[0].children[0].value, '1');
});

test('Parse nested object', () => {
    const result = parse_json_objects(['{"person": {"name": "John", "age": 30}}'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 1);
    assertEquals(result[0].children[0].node_type, 'OBJECT');
    assertEquals(result[0].children[0].children.length, 2);
});

test('Parse nested array', () => {
    const result = parse_json_objects(['[[1, 2], [3, 4]]'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 2);
    assertEquals(result[0].children[0].node_type, 'ARRAY');
    assertEquals(result[0].children[0].children.length, 2);
});

test('Parse array of objects', () => {
    const result = parse_json_objects(['[{"id": 1}, {"id": 2}]'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children.length, 2);
    assertEquals(result[0].children[0].node_type, 'OBJECT');
    assertEquals(result[0].children[1].node_type, 'OBJECT');
});

test('Parse object with array value', () => {
    const result = parse_json_objects(['{"tags": ["red", "blue"]}'], [1]);
    assertEquals(result.length, 1);
    assertEquals(result[0].children[0].node_type, 'ARRAY');
    assertEquals(result[0].children[0].children.length, 2);
});

test('Parse multiple objects on separate lines', () => {
    const result = parse_json_objects(['{"id": 1}', '{"id": 2}'], [1, 2]);
    assertEquals(result.length, 2);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
});

test('Parse object with all scalar types', () => {
    const result = parse_json_objects(['{"str": "text", "num": 42, "bool": true, "null": null}'], [1]);
    assertEquals(result[0].children.length, 4);
    assertEquals(result[0].children[0].value, '"text"');
    assertEquals(result[0].children[1].value, '42');
    assertEquals(result[0].children[2].value, 'true');
    assertEquals(result[0].children[3].value, 'null');
});

test('Parse deeply nested structure', () => {
    const result = parse_json_objects(['{"a": {"b": {"c": {"d": 1}}}}'], [1]);
    assertEquals(result.length, 1);
    let node = result[0].children[0];
    assertEquals(node.node_type, 'OBJECT', 'Level 1');
    node = node.children[0];
    assertEquals(node.node_type, 'OBJECT', 'Level 2');
    node = node.children[0];
    assertEquals(node.node_type, 'OBJECT', 'Level 3');
    node = node.children[0];
    assertEquals(node.node_type, 'SCALAR', 'Level 4');
    assertEquals(node.value, '1');
    assertEquals(node.parent_key, '"d"');
    assertEquals(node.parent_key_position.line, 1);
    assertEquals(node.parent_key_position.character, 19);
});

test('Parse with line numbers', () => {
    const result = parse_json_objects(['{"key": "value"}'], [42]);
    assertEquals(result[0].start_position.line, 42);
});

test('Parse mixed valid and invalid content', () => {
    assertThrows(() => parse_json_objects(['garbage', '{"valid": 1}', 'more garbage'], [1, 2, 3]), 'Should throw on garbage', JsonTokenizerError);
});

test('Error on missing colon', () => {
    assertThrows(() => parse_json_objects(['{"key" "value"}'], [1]), 'Should throw on missing colon', JsonSyntaxError);
});

test('Error on missing comma in object', () => {
    assertThrows(() => parse_json_objects(['{"a": 1 "b": 2}'], [1]), 'Should throw on missing comma', JsonSyntaxError);
});

test('Error on missing comma in array', () => {
    assertThrows(() => parse_json_objects(['[1 2 3]'], [1]), 'Should throw on missing comma in array', JsonSyntaxError);
});

test('Error on trailing comma in object', () => {
    assertThrows(() => parse_json_objects(['{"key": "value",}'], [1]), 'Should throw on trailing comma', JsonSyntaxError);
});

test('Error on mismatched brackets', () => {
    assertThrows(() => parse_json_objects(['{"key": [1, 2}'], [1]), 'Should throw on mismatched brackets', JsonSyntaxError);
});

test('Parse empty object in array', () => {
    const result = parse_json_objects(['[{}]'], [1]);
    assertEquals(result[0].children[0].node_type, 'OBJECT');
    assertEquals(result[0].children[0].children.length, 0);
});

test('Parse empty array in object', () => {
    const result = parse_json_objects(['{"arr": []}'], [1]);
    assertEquals(result[0].children[0].node_type, 'ARRAY');
    assertEquals(result[0].children[0].children.length, 0);
});

test('Parse with leading incomplete JSON', () => {
    const text = `    "incomplete": "value"}
{"id": 1}
{"id": 2}`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 2);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
});

test('Parse with trailing incomplete object JSON', () => {
    const text = `{"id": 1}
{"id": 2}
{"incomplete": `;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 2);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
});

test('Parse with trailing incomplete array JSON', () => {
    const text = `{"id": 1}
{"id": 2}
["incomplete", `;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 2);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
});

test('Parse with both leading and trailing incomplete JSON', () => {
    const text = `    "leading": "incomplete"}
{"id": 1}
{"id": 2}
{"id": 3}
{"trailing": "incomplete"`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 3);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
    assertEquals(result[2].children[0].value, '3');
});

test('Parse with indented incomplete leading JSON', () => {
    const text = `        "key": "value",
        "another": 123
    }
{"valid": true}`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 1);
    assertEquals(result[0].children[0].value, 'true');
});

test('Parse multiline object with leading incomplete', () => {
    const text = `}
{
    "name": "John",
    "age": 30
}
{
    "name": "Jane",
    "age": 25
}`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 2);
    assertEquals(result[0].children.length, 2);
    assertEquals(result[0].children[0].value, '"John"');
    assertEquals(result[1].children[0].value, '"Jane"');
});

test('Leading Trailing Incomplete', () => {
    const text = `"key": {"id": "before1"}},
    {"id": "before2"},
    {"id": "before3"}
]
{
    "id": "inside1"
}
{
    "id": "inside2"
}
[  {"id": "after1"},
   {
        "key": {"id": "after2"},
        "key": {"id": "after3"},
        "key": [ {"id": "after4"},

`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 9);
    assertEquals(result[0].children[0].value, '"before1"');
    assertEquals(result[0].relative_depth, 2);
    assertEquals(result[1].children[0].value, '"before2"');
    assertEquals(result[1].relative_depth, 1);
    assertEquals(result[2].children[0].value, '"before3"');
    assertEquals(result[3].children[0].value, '"inside1"');
    assertEquals(result[3].relative_depth, 0);
    assertEquals(result[4].children[0].value, '"inside2"');
    assertEquals(result[5].children[0].value, '"after1"');
    assertEquals(result[6].children[0].value, '"after2"');
    assertEquals(result[7].children[0].value, '"after3"');
    assertEquals(result[8].children[0].value, '"after4"');
    assertEquals(result[8].relative_depth, 3);
});



test('Parse with invalid syntax in middle', () => {
    // Full object grouping pre-processing should allow to skip the incomplete array in the middle.
    // Not that this is the right behaviour though.
    // Would be better to throw a syntax error, but we don't check incomplete objects for syntax issues.
    const text = `{"id": 1}
[1, 2, 3
{"id": 2}`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 2);
});

test('Parse with empty lines between objects', () => {
    const text = `{"id": 1}

{"id": 2}

{"id": 3}`;
    const lines = text.split('\n');
    const line_nums = lines.map((_, i) => i + 1);
    const result = parse_json_objects(lines, line_nums);
    assertEquals(result.length, 3);
    assertEquals(result[0].children[0].value, '1');
    assertEquals(result[1].children[0].value, '2');
    assertEquals(result[2].children[0].value, '3');
});

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length > 0) {
    if (args[0] === '--list' || args[0] === '-l') {
        listTests();
    } else if (args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: node unit_tests.js [options] [test_ids...]');
        console.log('\nOptions:');
        console.log('  --list, -l       List all available tests with their IDs');
        console.log('  --help, -h       Show this help message');
        console.log('  --fail-fast, -f  Stop on first failure and rethrow the error');
        console.log('\nExamples:');
        console.log('  node unit_tests.js              # Run all tests');
        console.log('  node unit_tests.js 1 5 10       # Run tests with IDs 1, 5, and 10');
        console.log('  node unit_tests.js --list       # List all tests');
        console.log('  node unit_tests.js -f           # Run all tests, stop on first failure');
        console.log('  node unit_tests.js -f 1 5 10    # Run specific tests, stop on first failure');
    } else {
        let rethrowOnFailure = false;
        let testIdArgs = args;
        
        // Check for fail-fast flag
        if (args[0] === '--fail-fast' || args[0] === '-f') {
            rethrowOnFailure = true;
            testIdArgs = args.slice(1);
        }

        let testIds = null;
        
        if (testIdArgs.length === 0) {
            console.log(`Running all tests${rethrowOnFailure ? ' (fail-fast mode)' : ''}...\n`);
        } else {
            // Parse test IDs
            testIds = testIdArgs.map(arg => {
                const id = parseInt(arg, 10);
                if (isNaN(id)) {
                    console.error(`Invalid test ID: ${arg}`);
                    process.exit(1);
                }
                return id;
            });
            console.log(`Running ${testIds.length} selected test(s)${rethrowOnFailure ? ' (fail-fast mode)' : ''}...\n`);
        }
        runTests(testIds, rethrowOnFailure);
    }
} else {
    console.log('Running all tests...\n');
    runTests();
}
