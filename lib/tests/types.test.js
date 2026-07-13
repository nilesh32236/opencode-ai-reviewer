"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const schemas_js_1 = require("../src/types/schemas.js");
(0, vitest_1.describe)('types', () => {
    (0, vitest_1.it)('ReviewEntrySchema validates a valid issue', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'issue',
            severity: 'critical',
            file: 'src/test.ts',
            line: 10,
            message: 'Test issue message',
        });
        (0, vitest_1.expect)(valid.success).toBe(true);
    });
    (0, vitest_1.it)('ReviewEntrySchema validates a valid summary', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'summary',
            text: 'This is a valid summary text that is long enough.',
        });
        (0, vitest_1.expect)(valid.success).toBe(true);
    });
    (0, vitest_1.it)('ReviewEntrySchema validates a valid verdict', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'verdict',
            ready: true,
            reasoning: 'The reasoning is long enough to pass.',
        });
        (0, vitest_1.expect)(valid.success).toBe(true);
    });
    (0, vitest_1.it)('ReviewEntrySchema rejects invalid severity', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'issue',
            severity: 'blocker',
            file: 'src/test.ts',
            line: 10,
            message: 'Test issue message',
        });
        (0, vitest_1.expect)(valid.success).toBe(false);
    });
    (0, vitest_1.it)('ReviewEntrySchema rejects issue without file', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'issue',
            severity: 'critical',
            line: 10,
            message: 'Test issue message',
        });
        (0, vitest_1.expect)(valid.success).toBe(false);
    });
    (0, vitest_1.it)('ReviewEntrySchema rejects issue with line <= 0', () => {
        const valid = schemas_js_1.ReviewEntrySchema.safeParse({
            type: 'issue',
            severity: 'critical',
            file: 'src/test.ts',
            line: 0,
            message: 'Test issue message',
        });
        (0, vitest_1.expect)(valid.success).toBe(false);
    });
});
