import { describe, it, expect } from 'vitest';
import { SYSTEM_TASK_AUTHOR, isSystemTask, technicalContacts } from './systemAlerts';

describe('technicalContacts', () => {
  it('ALERT_EMAIL wins, normalised and de-duplicated', () => {
    expect(technicalContacts({ ALERT_EMAIL: ' Ops@x.cz, ops@x.cz ,b@y.cz', ADMIN_EMAILS: 'owner@x.cz' })).toEqual([
      'ops@x.cz',
      'b@y.cz',
    ]);
  });

  it('falls back to the FIRST admin only — the owner, not every admin', () => {
    expect(technicalContacts({ ADMIN_EMAILS: 'owner@x.cz, partner@x.cz' })).toEqual(['owner@x.cz']);
  });

  it('is empty when nothing is configured', () => {
    expect(technicalContacts({})).toEqual([]);
    expect(technicalContacts({ ALERT_EMAIL: ' , ', ADMIN_EMAILS: '' })).toEqual([]);
  });
});

describe('isSystemTask', () => {
  it('tells system-raised tasks from operator ones', () => {
    expect(isSystemTask({ createdBy: SYSTEM_TASK_AUTHOR })).toBe(true);
    expect(isSystemTask({ createdBy: 'owner@x.cz' })).toBe(false);
  });
});
