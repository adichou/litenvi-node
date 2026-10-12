import fs from 'node:fs';
console.log(`${process.argv[2]}:${fs.readFileSync('/mock/project/input.txt','utf8')}`);
