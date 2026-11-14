import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleSuite } from './cli.mjs';
import { validateSuite, validateVerdict } from './schema.mjs';
test('case schema requires fixed acceptance and bounded paid/tool rounds', () => {
    assert.equal(validateSuite(exampleSuite()).cases.length, 1);
    for (const mutate of [s => s.limits.maxRequests = 0, s => s.limits.maxReworks = 99, s => s.cases[0].requirements = [], s => s.primary.model = '', s => s.decisions.model = 'other', s => s.cases[0].snapshot = { repoRoot: 'repo', commit: 'HEAD', mode: 'commit' }]) {
        const s = exampleSuite();
        mutate(s);
        assert.throws(() => validateSuite(s));
    }
});
test('test recipes require pinned images and frozen validation inputs', () => {
    const s = exampleSuite();
    s.cases[0].recipes = [{ id: 'unit', argv: ['node', 'test.mjs'], timeoutMs: 1000, protectedPaths: ['test.mjs'] }];
    assert.throws(() => validateSuite(s), /docker/);
    s.cases[0].dockerImage = 'fixture@sha256:' + 'a'.repeat(64);
    assert.doesNotThrow(() => validateSuite(s));
    s.cases[0].recipes[0].protectedPaths = ['../test.mjs'];
    assert.throws(() => validateSuite(s), /recipe/);
});
test('judge cannot omit or duplicate requirements or turn uncertainty into acceptance', () => {
    const req = [{ id: 'goal', description: 'goal', critical: true }];
    assert.throws(() => validateVerdict({ items: [] }, req));
    assert.throws(() => validateVerdict({ items: [{ id: 'foreign', status: 'met', evidence: 'x' }] }, req));
    const v = validateVerdict({ items: [{ id: 'goal', status: 'uncertain', evidence: 'not verified' }] }, req);
    assert.equal(v.accepted, false);
    assert.deepEqual(v.criticalMissingIds, ['goal']);
});
