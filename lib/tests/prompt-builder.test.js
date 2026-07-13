"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const builder_js_1 = require("../src/prompts/builder.js");
(0, vitest_1.describe)('prompt-builder', () => {
    (0, vitest_1.it)('buildReviewPrompt returns a non-empty string', () => {
        const prompt = (0, builder_js_1.buildReviewPrompt)({ reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' }, 'PR #1 test');
        (0, vitest_1.expect)(prompt).toBeTruthy();
        (0, vitest_1.expect)(typeof prompt).toBe('string');
        (0, vitest_1.expect)(prompt.length).toBeGreaterThan(50);
    });
    (0, vitest_1.it)('buildReviewPrompt includes the PR context', () => {
        const prContext = 'Test PR context with specific details';
        const prompt = (0, builder_js_1.buildReviewPrompt)({ reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' }, prContext);
        (0, vitest_1.expect)(prompt).toContain(prContext);
    });
    (0, vitest_1.it)('buildReviewPrompt appends reviewPromptExtra when set', () => {
        const extra = 'EXTRA_INSTRUCTIONS';
        const prompt = (0, builder_js_1.buildReviewPrompt)({ reviewPromptFile: '', reviewPromptExtra: extra, maxFilesPerBatch: 3, projectContext: '' }, 'PR #1');
        (0, vitest_1.expect)(prompt).toContain(extra);
    });
    (0, vitest_1.it)('buildFixPrompt returns a non-empty string', () => {
        const prompt = (0, builder_js_1.buildFixPrompt)({ reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' }, 'PR context with issues', 1);
        (0, vitest_1.expect)(prompt).toBeTruthy();
        (0, vitest_1.expect)(typeof prompt).toBe('string');
    });
    (0, vitest_1.it)('buildFixPrompt includes the iteration number', () => {
        const prompt = (0, builder_js_1.buildFixPrompt)({ reviewPromptFile: '', reviewPromptExtra: '', maxFilesPerBatch: 3, projectContext: '' }, 'Some context', 2);
        (0, vitest_1.expect)(prompt).toContain('2');
    });
});
