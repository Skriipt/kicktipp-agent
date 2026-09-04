import type { ReminderCapability } from '../../src/reminder-capability.js';
import type { ServiceConfiguration, ServiceState } from '../../src/service/store.js';

export const SERVICE_JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';

export function serviceConfiguration(
  targets: ServiceConfiguration['targets'] = [],
): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: SERVICE_JOB_ID,
      name: 'community-reminder',
      enabled: targets.length > 0,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      policy: {
        excludeParticipantIds: [],
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: targets.map(({ id }) => id),
    },
    targets,
  };
}

export function serviceNotification(options: {
  now: Date;
  message: string;
  displayName: string;
  content?: Partial<ServiceState['notifications'][number]['content']>;
}): ServiceState['notifications'][number] {
  return {
    id: 'a'.repeat(64),
    jobId: SERVICE_JOB_ID,
    createdAt: options.now.toISOString(),
    language: 'en',
    displayTimezone: 'Europe/Berlin',
    content: {
      schemaVersion: 1,
      type: 'reminder',
      severity: 'warning',
      title: 'Kicktipp reminder: Family',
      message: options.message,
      actionUrl: 'https://www.kicktipp.com/family/predict',
      ...options.content,
    },
    deadlineGroup: {
      id: 'b'.repeat(64),
      deadlineAt: '2026-09-04T12:00:00.000Z',
      gameIds: ['game-1'],
    },
    stage: '60',
    missingParticipants: [{ id: 'alice', displayName: options.displayName }],
  };
}

export function serviceCapability(displayName: string): ReminderCapability {
  return {
    available: true,
    snapshot: {
      profileId: 'service-profile',
      communityId: 'family',
      sourceTimeZone: 'Europe/Berlin',
      participants: [{ id: 'alice', displayName }],
      games: [{
        id: 'game-1',
        deadlineAt: '2026-09-04T12:00:00.000Z',
        deadlineSource: 'event',
      }],
      cells: [{ participantId: 'alice', gameId: 'game-1', status: 'missing' }],
    },
  };
}
