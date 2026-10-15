const { parseJsonlString } = require('./lib/dist/jsonl-parser.js');

const jsonl = `{"type":"verdict","ready":true,"reasoning":"Looks good","autoFixable":false,"confidence":"high"}
{"type":"issue","severity":"minor","file":"src/index.ts","line":1,"message":"test","inline":true}`;

const result = parseJsonlString(jsonl);
console.log('parseJsonlString result:', JSON.stringify(result, null, 2));
