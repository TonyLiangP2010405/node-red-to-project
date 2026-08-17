const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inferDependencies } = require('../src/deps');

function createUserDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'node-red-to-project-'));
}

function removeDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

test('resolves core node types to @node-red/nodes', () => {
    const result = inferDependencies(['inject', 'debug', 'mqtt in']);

    assert.deepStrictEqual(result.deps, {
        '@node-red/nodes': '^5.0.0'
    });
    assert.deepStrictEqual(result.resolved, {
        inject: '@node-red/nodes',
        debug: '@node-red/nodes',
        'mqtt in': '@node-red/nodes'
    });
    assert.deepStrictEqual(result.unknown, []);
});

test('reverse-resolves contrib node types from a local Node-RED user directory', () => {
    const userDir = createUserDir();
    const packageName = 'node-red-contrib-example';
    const packageDir = path.join(userDir, 'node_modules', packageName);

    try {
        fs.mkdirSync(path.join(packageDir, 'nodes'), { recursive: true });
        fs.writeFileSync(
            path.join(userDir, 'package.json'),
            JSON.stringify({
                dependencies: {
                    [packageName]: '^1.2.3'
                }
            })
        );
        fs.writeFileSync(
            path.join(packageDir, 'package.json'),
            JSON.stringify({
                name: packageName,
                version: '1.2.3',
                'node-red': {
                    nodes: {
                        example_node: 'nodes/example.js'
                    }
                }
            })
        );
        fs.writeFileSync(
            path.join(packageDir, 'nodes', 'example.js'),
            'RED.nodes.registerType("example_node", function(config) {});'
        );

        const result = inferDependencies(['example_node'], { userDir });

        assert.deepStrictEqual(result.deps, {
            [packageName]: '^1.2.3'
        });
        assert.deepStrictEqual(result.resolved, {
            example_node: packageName
        });
        assert.deepStrictEqual(result.unknown, []);
    } finally {
        removeDir(userDir);
    }
});

test('adds unknown types with a normalized contrib package suggestion', () => {
    const result = inferDependencies(['ui_button']);

    assert.deepStrictEqual(result.deps, {
        'node-red-contrib-ui-button': 'latest'
    });
    assert.deepStrictEqual(result.resolved, {});
    assert.deepStrictEqual(result.unknown, [
        {
            type: 'ui_button',
            suggestion: 'node-red-contrib-ui-button'
        }
    ]);
});

test('falls back to heuristic suggestions when the local user directory is missing', () => {
    const missingUserDir = path.join(os.tmpdir(), 'node-red-to-project-does-not-exist');

    assert.doesNotThrow(() => inferDependencies(['custom node'], { userDir: missingUserDir }));

    const result = inferDependencies(['custom node'], { userDir: missingUserDir });

    assert.deepStrictEqual(result.deps, {
        'node-red-contrib-custom-node': 'latest'
    });
    assert.deepStrictEqual(result.resolved, {});
    assert.deepStrictEqual(result.unknown, [
        {
            type: 'custom node',
            suggestion: 'node-red-contrib-custom-node'
        }
    ]);
});
