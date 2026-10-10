// 用例集统一运行器：顺序执行（支持同步与 async 用例）、单例失败不中断其余用例、最后汇总；
// 有失败以非零退出（shell 契约）。末尾输出 CASES_SUMMARY 机器可读行，供聚合入口汇总跨文件统计。
export async function runCases(cases) {
  let failed = 0;
  for (const run of cases) {
    try {
      await run();
    } catch (error) {
      failed += 1;
      console.error(`✗ ${run.name}：${error.message}`);
    }
  }
  console.log(`CASES_SUMMARY ${JSON.stringify({ total: cases.length, failed })}`);
  if (failed) {
    console.error(`共 ${cases.length} 个用例，失败 ${failed}`);
    process.exit(1);
  }
  console.log(`共 ${cases.length} 个用例，全部通过`);
}
