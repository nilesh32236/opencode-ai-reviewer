var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: () => m[k] };
        }
        Object.defineProperty(o, k2, desc);
      }
    : (o, m, k, k2) => {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? (o, v) => {
        Object.defineProperty(o, 'default', { enumerable: true, value: v });
      }
    : (o, v) => {
        o['default'] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (() => {
    var ownKeys = (o) => {
      ownKeys =
        Object.getOwnPropertyNames ||
        ((o) => {
          var ar = [];
          for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        });
      return ownKeys(o);
    };
    return (mod) => {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== 'default') __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, '__esModule', { value: true });
const jsonl_parser_js_1 = require('../src/jsonl-parser.js');
const fs = __importStar(require('fs'));
const path = __importStar(require('path'));
describe('jsonl-parser', () => {
  describe('parseJsonlString', () => {
    it('parses a complete valid JSONL with all finding types', () => {
      const input = [
        JSON.stringify({ type: 'summary', text: 'Overall looks good.' }),
        JSON.stringify({ type: 'verdict', ready: true, reasoning: 'No issues found.' }),
        JSON.stringify({
          type: 'strength',
          file: 'src/foo.ts',
          line: 10,
          message: 'Good pattern.',
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'critical',
          file: 'src/bar.ts',
          line: 42,
          message: 'Missing null check.',
          suggestion: 'Add if (!x) return;',
          inline: true,
        }),
        JSON.stringify({
          type: 'issue',
          severity: 'minor',
          file: 'src/baz.ts',
          line: 7,
          message: 'Unused import.',
        }),
      ].join('\n');
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.summary).toContain('Overall looks good.');
      expect(result.verdict.ready).toBe(true);
      expect(result.strengths).toHaveLength(1);
      expect(result.strengths[0].message).toBe('Good pattern.');
      expect(result.issues).toHaveLength(2);
      expect(result.stats.critical).toBe(1);
      expect(result.stats.important).toBe(0);
      expect(result.stats.minor).toBe(1);
      expect(result.failedLines).toBe(0);
    });
    it('handles empty input', () => {
      const result = (0, jsonl_parser_js_1.parseJsonlString)('');
      expect(result.summary).toBe('');
      expect(result.verdict.ready).toBe(false);
      expect(result.strengths).toHaveLength(0);
      expect(result.issues).toHaveLength(0);
    });
    it('handles malformed lines gracefully', () => {
      const input = [
        JSON.stringify({ type: 'summary', text: 'Good.' }),
        'this is not json',
        JSON.stringify({ type: 'verdict', ready: false, reasoning: 'Issues.' }),
        '{broken json',
      ].join('\n');
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.summary).not.toBe('');
      expect(result.verdict.ready).toBe(false);
      expect(result.failedLines).toBe(2);
    });
    it('handles blank lines', () => {
      const input = ['', '  ', JSON.stringify({ type: 'summary', text: 'Test.' }), ''].join('\n');
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.summary).not.toBe('');
      expect(result.failedLines).toBe(0);
    });
    it('rejects invalid severity', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'blocker',
        file: 'f.ts',
        line: 1,
        message: 'bad',
      });
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });
    it('rejects issue without file', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        message: 'missing file',
      });
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });
    it('rejects issue with line <= 0', () => {
      const input = JSON.stringify({
        type: 'issue',
        severity: 'critical',
        file: 'f.ts',
        line: 0,
        message: 'bad line',
      });
      const result = (0, jsonl_parser_js_1.parseJsonlString)(input);
      expect(result.issues).toHaveLength(0);
      expect(result.failedLines).toBe(1);
    });
  });
  describe('parseJsonlFile', () => {
    it('reads and parses a file', () => {
      const fixturePath = path.join(__dirname, 'fixtures/sample-review-output.jsonl');
      if (!fs.existsSync(fixturePath)) {
        fs.writeFileSync(
          fixturePath,
          [
            JSON.stringify({ type: 'summary', text: 'Test summary.' }),
            JSON.stringify({ type: 'verdict', ready: true, reasoning: 'Looks good.' }),
          ].join('\n'),
        );
      }
      const result = (0, jsonl_parser_js_1.parseJsonlFile)(fixturePath);
      expect(result.summary).toContain('JWT authentication');
      expect(result.verdict.ready).toBe(false);
    });
    it('returns empty result for non-existent file', () => {
      const result = (0, jsonl_parser_js_1.parseJsonlFile)('/nonexistent/path/file.jsonl');
      expect(result.summary).toBe('');
      expect(result.issues).toHaveLength(0);
    });
  });
  describe('buildReviewBody', () => {
    it('builds a complete review body', () => {
      const result = {
        summary: 'Good PR overall.',
        verdict: { ready: false, reasoning: 'One critical issue found.' },
        strengths: [{ type: 'strength', file: 'src/a.ts', line: 10, message: 'Clean function.' }],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/b.ts',
            line: 42,
            message: 'Missing auth check.',
            suggestion: 'Add requireAuth middleware.',
          },
        ],
        stats: { total: 1, critical: 1, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      const body = (0, jsonl_parser_js_1.buildReviewBody)(result);
      expect(body).toContain('## AI Code Review Summary');
      expect(body).toContain('Good PR overall.');
      expect(body).toContain('**Ready to merge?** No');
      expect(body).toContain('One critical issue found.');
      expect(body).toContain('Clean function.');
      expect(body).toContain('CRITICAL');
      expect(body).toContain('Missing auth check.');
      expect(body).toContain('Add requireAuth middleware.');
    });
    it('handles empty result gracefully', () => {
      const emptyResult = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [],
        stats: { total: 0, critical: 0, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      const body = (0, jsonl_parser_js_1.buildReviewBody)(emptyResult);
      expect(body).toContain('No summary provided');
      expect(body).toContain('No reasoning provided');
    });
  });
  describe('buildInlineComments', () => {
    it('only includes inline=true issues with valid lines', () => {
      const result = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'Bug here.',
            suggestion: 'Fix it.',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'minor',
            file: 'src/b.ts',
            line: 20,
            message: 'Style issue.',
            inline: false,
          },
          {
            type: 'issue',
            severity: 'important',
            file: 'src/c.ts',
            line: 30,
            message: 'No inline flag.',
          },
        ],
        stats: { total: 3, critical: 1, important: 1, minor: 1 },
        rawLines: [],
        failedLines: 0,
      };
      const comments = (0, jsonl_parser_js_1.buildInlineComments)(result);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe('src/a.ts');
      expect(comments[0].line).toBe(10);
      expect(comments[0].body).toContain('CRITICAL');
      expect(comments[0].body).toContain('Bug here.');
    });
    it('filters by diff lines when provided', () => {
      const result = {
        summary: '',
        verdict: { ready: false, reasoning: '' },
        strengths: [],
        issues: [
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 10,
            message: 'In diff.',
            inline: true,
          },
          {
            type: 'issue',
            severity: 'critical',
            file: 'src/a.ts',
            line: 999,
            message: 'Not in diff.',
            inline: true,
          },
        ],
        stats: { total: 2, critical: 2, important: 0, minor: 0 },
        rawLines: [],
        failedLines: 0,
      };
      const diffLines = new Set(['src/a.ts:10', 'src/a.ts:11', 'src/a.ts:12']);
      const comments = (0, jsonl_parser_js_1.buildInlineComments)(result, diffLines);
      expect(comments).toHaveLength(1);
      expect(comments[0].line).toBe(10);
    });
  });
});
