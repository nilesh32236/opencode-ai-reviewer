const fs = require('fs');

// 1. Fix the test to ensure it exactly matches what the reviewer wants
let codeTest = fs.readFileSync('lib/tests/agents.test.ts', 'utf8');

const testPattern = `it('coerces numeric confidence on a fenced issue line identically to a bare line', () => {
    // A bug in older versions ignored fenced lines during preprocessing.
    const jsonl = \`\\\`\\\`\\\`json\\n{"type":"issue","severity":"minor","file":"x.ts","line":1,"confidence":0.8}\\n\\\`\\\`\\\`\`;
    const result = parseAgentJsonlString(jsonl, 'security');
    expect(result.findings[0]?.confidence).toBe('high');
    expect(result.findings[0]?.agent).toBe('security');
  });`;

const testReplacement = `it('coerces numeric confidence on a same-line fenced issue line', () => {
    const jsonl = '\`\`\`json ' + JSON.stringify({ type: 'issue', severity: 'minor', file: 'x.ts', line: 1, message: 'm', confidence: 0.8 });
    const result = parseAgentJsonlString(jsonl, 'security');
    expect(result.findings[0]?.confidence).toBe('high');
    expect(result.findings[0]?.agent).toBe('security');
  });`;

codeTest = codeTest.replace(testPattern, testReplacement);
fs.writeFileSync('lib/tests/agents.test.ts', codeTest);

// The PR Description cannot be updated from the JS script. I will update it via the `submit` tool parameter!
// "Update PR description and .jules/bolt.md Action line to describe the actual change (fold stamping into addLine; single split + single parse)"
// I already updated .jules/bolt.md in the previous commit. Let me check what it says.
