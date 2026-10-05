import { describe, expect, it } from 'vitest';
import { assessUrgency, matchUrgentKeywords } from './urgentMessage';

describe('matchUrgentKeywords — fires', () => {
  it.each([
    'URGENT: please call me',
    'This is an emergency',
    'We cannot stay here, the room smells',
    'This is unacceptable',
    'We have a serious problem with the apartment',
    "We're locked out of the apartment",
    "The door lock doesn't work",
    'The key does not work',
    'Power outage in the whole apartment',
    'There is no electricity',
    'Heating is not working and it is freezing',
    'No hot water in the shower',
    'Water is not running',
    'Nejde teplá voda',
    'Nejde topení, je tu zima',
    'Zabouchli jsme se, nemůžeme se dostat dovnitř',
    'Výpadek proudu',
    'Je to nepřijatelné',
    'Nejde odemknout dveře',
    'Water leaking from the ceiling',
    'Heizung funktioniert nicht',
  ])('%s', (msg) => {
    expect(matchUrgentKeywords(msg).urgent).toBe(true);
  });
});

describe('matchUrgentKeywords — stays quiet on everyday messages', () => {
  it.each([
    'Děkuji za pomoc, vše v pořádku',
    'Can you help me with parking?',
    'Can we smoke on the balcony?',
    'Is the Špilberk zámek worth a visit?',
    'Thank you, see you tomorrow!',
    'What is the wifi password?',
    'We will arrive right now-ish, around 15:00',
    'Is there a gas hob or plynový sporák?',
  ])('%s', (msg) => {
    expect(matchUrgentKeywords(msg).urgent).toBe(false);
  });
});

describe('assessUrgency', () => {
  it('the classifier alone can flag a message', () => {
    const r = assessUrgency('We have been waiting outside for an hour', {
      urgent: true,
      urgentReason: 'guest stuck outside',
    });
    expect(r.urgent).toBe(true);
    expect(r.labels[0]).toBe('guest stuck outside');
  });
});
