"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const config_js_1 = require("../src/config.js");
const index_js_1 = require("../src/types/index.js");
(0, vitest_1.describe)('config', () => {
    (0, vitest_1.it)('DEFAULT_CONFIG is defined', () => {
        (0, vitest_1.expect)(index_js_1.DEFAULT_CONFIG).toBeDefined();
        (0, vitest_1.expect)(index_js_1.DEFAULT_CONFIG.reviewModel).toBeTruthy();
    });
    (0, vitest_1.it)('loadConfig returns null when config file missing', () => {
        const config = (0, config_js_1.loadConfig)('/nonexistent');
        (0, vitest_1.expect)(config).toBeNull();
    });
    (0, vitest_1.it)('loadConfig returns null for empty working dir', () => {
        const config = (0, config_js_1.loadConfig)('');
        (0, vitest_1.expect)(config).toBeNull();
    });
});
