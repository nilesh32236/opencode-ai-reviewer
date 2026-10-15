const fs = require('fs');
const filePath = 'lib/src/jsonl-parser.ts';
let code = fs.readFileSync(filePath, 'utf-8');

const targetPattern = `function forEachLine(content: string, cb: (line: string) => void): void {
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf('\\n', index);
    if (nextIndex === -1) {
      cb(content.substring(index));
      break;
    }
    cb(content.substring(index, nextIndex));
    index = nextIndex + 1;
  }
}`;

const replacementPattern = `function forEachLine(content: string, cb: (line: string) => void): void {
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf('\\n', index);
    if (nextIndex === -1) {
      cb(content.substring(index));
      break;
    }
    cb(content.substring(index, nextIndex));
    index = nextIndex + 1;
  }
}`;

if (code.includes('if (nextIndex === -1) {')) {
   // wait, the problem is PR review 4279291361 explicitly said:
   // "Unconditional index = nextIndex + 1 sets index to 0 on the last line (nextIndex is -1), so the empty-string guard below must test index === 0. It works only because every isLast path breaks immediately, but the reset value is misleading for future edits."
   // That issue was present in the *first* iteration of my code before extracting it to forEachLine!
   // In forEachLine, `if (nextIndex === -1) { cb(); break; }` means it breaks BEFORE index = nextIndex + 1!
   // Wait, if it breaks BEFORE, then `index` is NOT reassigned to 0 on the last line!
   // So it's perfectly correct!
   console.log("No fix needed for index assignment because we already break before it.");
}
