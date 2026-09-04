import type { Command } from 'commander';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { doctorExitCode, runDoctor, type DoctorReport } from '../service/doctor.js';

function printDoctor(report: DoctorReport): void {
  console.log(`Service readiness: ${report.ready ? 'ready' : 'blocked'}`);
  for (const finding of report.findings) {
    const target = finding.target ? ` [${finding.target.id}/${finding.target.provider}]` : '';
    console.log(`${finding.status.toUpperCase()} ${finding.code}${target}: ${finding.message}`);
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate local Service readiness and safe online capabilities')
    .option('--offline', 'Perform no Kicktipp or provider requests')
    .option('--json', 'Output JSON')
    .action(async (options: { offline?: boolean; json?: boolean }) => {
      if (options.json) setJsonMode(true);
      const report = await runDoctor({ offline: options.offline });
      if (options.json) emitJson(report);
      else printDoctor(report);
      process.exitCode = doctorExitCode(report);
    });
}
