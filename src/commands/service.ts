import type { Command } from 'commander';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { reminderRunExitCode, runReminderOnce } from '../service/delivery.js';
import { runReminderDryRun, type ReminderPreview } from '../service/dry-run.js';
import type { LogFormat } from '../service/logging.js';
import { getServiceStatus, type ServiceStatus } from '../service/status.js';
import { runServiceSupervisor } from '../service/supervisor.js';

function printPreview(preview: ReminderPreview): void {
  console.log(`Reminder dry run: ${preview.outcome}`);
  console.log(`Job: ${preview.job.id}`);
  console.log(`Auth Profile: ${preview.job.profileId}`);
  console.log(`Community: ${preview.job.communityId}`);
  if (preview.deadlineGroup) {
    console.log(`Deadline Group: ${preview.deadlineGroup.deadlineAt} (${preview.deadlineGroup.gameIds.join(', ')})`);
  }
  if (preview.stage) console.log(`Stage: ${preview.stage.beforeDeadlineMinutes} minutes (${preview.stage.severity})`);
  if (preview.skippedStages.length) {
    console.log(`Skipped crossed Stages: ${preview.skippedStages.map(({ beforeDeadlineMinutes }) => beforeDeadlineMinutes).join(', ')}`);
  }
  if (preview.missingParticipants.length) {
    console.log('Missing Participants:');
    for (const participant of preview.missingParticipants) {
      console.log(`  ${participant.displayName} (${participant.id})`);
    }
  }
  if (preview.targets.length) {
    console.log('Notification Targets:');
    for (const target of preview.targets) {
      console.log(`  ${target.id} (${target.provider}, revision ${target.revision})`);
    }
  }
}

function printHealth(status: ServiceStatus): void {
  console.log(`Service Health: ${status.health.status}`);
  console.log(`Reasons: ${status.health.reasons.join(', ')}`);
  if (!status.readable) console.error(status.error.safeMessage);
}

function printStatus(status: ServiceStatus): void {
  printHealth(status);
  if (!status.readable) return;
  console.log(`Runtime: ${status.runtime.running ? 'running' : 'not running'} (${status.runtime.lockStatus})`);
  console.log(`Job: ${status.job.id} ${status.job.name} (${status.job.enabled ? 'enabled' : 'disabled'})`);
  console.log(`Auth Profile: ${status.job.profileId}`);
  console.log(`Community: ${status.job.communityId}`);
  console.log(`Session: ${status.session.condition}`);
  console.log(`Next wake: ${status.runtime.nextWakeAt ?? 'unknown'} (${status.runtime.nextWakeReason ?? 'unknown'})`);
  console.log(`Last Schedule fetch: ${status.checks.lastScheduleFetchAt ?? 'never'}`);
  console.log(`Last Reliable Check: ${status.checks.lastReliableCheckAt ?? 'never'}`);
  if (status.checks.error) console.log(`Current error: ${status.checks.error.code}`);
  for (const target of status.targets) {
    const secrets = target.secrets.map(({ purpose, sourceClass }) => `${purpose}:${sourceClass}`).join(', ');
    console.log(`Target: ${target.id} ${target.provider} ${target.enabled ? 'enabled' : 'disabled'} ${target.revision} ${secrets || 'no secrets'}`);
  }
  for (const notification of status.notifications) {
    console.log(`Notification: ${notification.id} missing=${notification.missingParticipantCount} deadline=${notification.deadlineAt}`);
  }
  for (const delivery of status.deliveries) {
    console.log(`Delivery: ${delivery.id} ${delivery.state} attempts=${delivery.attemptCount}${delivery.nextAttemptAt ? ` retry=${delivery.nextAttemptAt}` : ''}`);
  }
  for (const notification of status.details?.notifications ?? []) {
    console.log(`Notification content: ${notification.content.title}`);
    console.log(notification.content.message);
    for (const participant of notification.missingParticipants) {
      console.log(`Missing Participant: ${participant.displayName} (${participant.id})`);
    }
  }
}

export function registerServiceCommand(program: Command): void {
  program
    .command('serve')
    .description('Run the Reminder Service continuously')
    .option('--log-format <format>', 'Log format: text or json', 'text')
    .action(async (options: { logFormat: string }) => {
      if (!['text', 'json'].includes(options.logFormat)) {
        throw new Error('Log format must be text or json.');
      }
      process.exitCode = await runServiceSupervisor({ logFormat: options.logFormat as LogFormat });
    });

  const service = program.command('service').description('Run and inspect the Reminder Service');
  service
    .command('status')
    .description('Read local Service Status without network requests')
    .option('--details', 'Include persisted Participant names and Notification content')
    .option('--json', 'Output JSON')
    .action((options: { details?: boolean; json?: boolean }) => {
      if (options.json) setJsonMode(true);
      const status = getServiceStatus({ details: options.details });
      if (options.json) emitJson(status);
      else printStatus(status);
      process.exitCode = status.readable ? 0 : 1;
    });

  service
    .command('health')
    .description('Read local Service Health without network requests')
    .option('--json', 'Output JSON')
    .action((options: { json?: boolean }) => {
      if (options.json) setJsonMode(true);
      const status = getServiceStatus();
      if (options.json) emitJson(status.health);
      else printHealth(status);
      process.exitCode = status.health.status === 'unhealthy' ? 1 : 0;
    });

  service
    .command('run-once')
    .description('Run currently due Reminder work once')
    .option('--dry-run', 'Preview without State changes or Notification delivery')
    .action(async (options: { dryRun?: boolean }) => {
      const result = options.dryRun ? await runReminderDryRun() : await runReminderOnce();
      if (!result.reliable) {
        console.error(`Reliable Reminder evaluation is impossible: ${result.reason}.`);
        process.exitCode = 1;
        return;
      }
      if (options.dryRun && 'preview' in result) {
        printPreview(result.preview);
        return;
      }
      if ('deliveryStates' in result) {
        console.log(`Reminder run: ${result.outcome}`);
        process.exitCode = reminderRunExitCode(result);
      }
    });
}
