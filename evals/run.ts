import { formatReport, loadCases, runCases } from './runner.ts';
import { placeholderSubject } from './subject.ts';

// CI entry point (`npm run evals`). Non-zero exit blocks the merge, exactly
// like a failing test — PIPELINE.md §5.
const report = await runCases(await loadCases(), placeholderSubject);
console.log(formatReport(report));
if (report.failed > 0) process.exitCode = 1;
