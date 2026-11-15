// 原生 ESM 规则夹具：依赖显式使用 lite-fs，执行位置直接属于真实源码。
import fs from '../../lite-fs.mjs';

export const moduleURL = import.meta.url;

export default {
  meta: { schema: [] },
  create(context) {
    return {
      Identifier(node) {
        if (node.name === 'bad') {
          const source = fs.readFileSync(context.filename, 'utf8');
          context.report({ node, message: `原生规则执行：${source.trim()}；${moduleURL}` });
        }
      },
    };
  },
};
