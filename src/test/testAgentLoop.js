import test from 'node:test';
import assert from 'node:assert';
import { runAgent } from '../agent/agent.js';

test('Agent Run Loop Function Signature', () => {
    assert.strictEqual(typeof runAgent, 'function');
});
