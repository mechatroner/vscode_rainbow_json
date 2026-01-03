const json_parse = require('./json_parse');

function get_path_signature(path) {
    return path ? path.join('->') : null;
}

/**
 * Recursively collects all (key, path) pairs from a node
 * @param {json_parse.RainbowJsonNode} node
 * @param {string[]} path - Current path like ["root", "foo", "bar"]
 * @param {Map<string, {count: number, order: number, name: string, path: string}>} freq_map
 */
function collect_keys_from_node(node, path, freq_map) {
    path = path.slice();
    if (node.parent_key) { // Array elements don't have parent keys.
        path.push(node.parent_key);
        let path_key = get_path_signature(path);
        if (freq_map.has(path_key)) {
            freq_map.get(path_key).count++;
        } else {
            let key_count = freq_map.size;
            freq_map.set(path_key, { count: 1, order: key_count, path: path.slice() });
        }
    }

    if (node.children) {
        for (let child of node.children) {
            collect_keys_from_node(child, path, freq_map);
        }
    }
}

function calculate_key_frequency_stats(lines, line_nums) {
    let records = [];
    try {
        // TODO in stats calculation we can do less robust error handling than in incremental parsing to ensure that we can use 'root' as the first path element.
        records = json_parse.parse_json_objects(lines, line_nums);
    } catch (e) {
        return [];
    }

    // Collect all (key, path) pairs with frequency and first-seen order
    let freq_map = new Map();
    for (let record of records) {
        // TODO: consider using 'root' as the first element here after making parsing in frequency stats more strict.
        // Using `root` would also allow matching to incremental matches to be more strict if it also adds 'root' for fully parsed records without incomplete parents.
        collect_keys_from_node(record, [], freq_map);
    }

    // Convert to array and sort by frequency (desc), then by first-seen order (asc) for ties
    let sorted_pairs = Array.from(freq_map.values())
        .sort((a, b) => {
            if (b.count !== a.count) {
                return b.count - a.count;
            }
            return a.order - b.order;
        });

    // Return top N most frequent (key, path) pairs
    return sorted_pairs.slice().map(item => ({ path: item.path, count: item.count }));
}

module.exports = {
    get_path_signature,
    calculate_key_frequency_stats
};
