import { spawn } from 'node:child_process';
import { bump } from './process-state.mjs';
export function launch(file, options) { bump(); return spawn('/mock/node', [file], options); }
