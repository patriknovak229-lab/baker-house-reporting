/**
 * Is a guest message URGENT — something the operator must see now, not when
 * they next open the dashboard? Drives the Telegram alert to the Baker House
 * Operations group.
 *
 * Two layers, either one is enough:
 *   1. The classifier's own judgement (`urgent` on the detection result) —
 *      catches phrasing no keyword list will ("we've been standing outside
 *      for an hour", "there's water all over the bathroom floor").
 *   2. This deterministic keyword pass — so the classic cases still fire
 *      when the LLM call fails or under-calls it. Covers EN / CS / SK / DE,
 *      with and without diacritics.
 *
 * Deliberately biased toward alerting: a false alarm costs a glance at a
 * phone, a missed lockout costs a guest standing in the street.
 */

/** Keyword families → short operator-facing label for the alert. */
const URGENT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  {
    label: 'urgent / emergency',
    // No bare "help" / "pomoc": "děkuji za pomoc", "can you help with
    // parking" are everyday messages.
    re: /(urgent\w*|emergenc\w*|\basap\b|naléhav\w*|nalehav\w*|urgentn\w*|nouzov\w*|havári\w*|havari\w*|pomozte nám|pomozte nam|dringend|notfall)/i,
  },
  {
    label: 'complaint — cannot stay / unacceptable',
    re: /(can['’]?t stay|cannot stay|can not stay|unacceptable|not acceptable|serious problem|big problem|major problem|disgust\w*|nepřijateln\w*|neprijateln\w*|nemůžeme (tu|tady|zde) (zůstat|bydlet|spát)|nemuzeme (tu|tady|zde) (zustat|bydlet|spat)|vážný problém|vazny problem|velký problém|velky problem|inakzeptabel|unzumutbar)/i,
  },
  {
    label: 'locked out / door or lock',
    re: /(locked out|lock(ed)? (ourselves|myself) out|can['’]?t (get|go) in|cannot (get|go) in|can['’]?t open|cannot open|door (won['’]?t|does not|doesn['’]?t|is not|isn['’]?t) (open|work|lock)|door ?lock|the lock (is|does|doesn|won|will not)|key (doesn['’]?t|does not|won['’]?t) work|lost (the |our |my )?keys?|chip (doesn['’]?t|does not|won['’]?t) work|zabouch\w*|nemůžeme (se )?dostat dovnitř|nemuzeme (se )?dostat dovnitr|nejde (otevřít|otevrit|odemknout|zamknout)|zámek (nefunguje|nejde|je rozbit)|zamek (nefunguje|nejde|je rozbit)|ztratil\w* klíč|ztratil\w* klic|klíč nefunguje|klic nefunguje|ausgesperrt|tür geht nicht|schlüssel (verloren|funktioniert nicht))/i,
  },
  {
    label: 'power outage',
    re: /(power (outage|cut|is out|went out|failure)|no (power|electricity)|electricity (is )?(out|off|gone)|lights? (don['’]?t|do not|won['’]?t) work|blackout|výpadek|vypadek|nejde (proud|elektřina|elektrina|světlo|svetlo)|není (proud|elektřina)|neni (proud|elektrina)|stromausfall|kein strom)/i,
  },
  {
    label: 'heating not working',
    re: /(heating (is )?(not|n['’]?t|doesn['’]?t|does not|won['’]?t|stopped)|no heating|heater (is )?(not|doesn['’]?t|does not|won['’]?t)|(it['’]?s|is) (freezing|very cold)|nejde (topení|topeni)|netopí|netopi|topení nefunguje|topeni nefunguje|je (tu|tady) zima|heizung (geht nicht|funktioniert nicht|kaputt))/i,
  },
  {
    label: 'water / hot water',
    re: /(no (hot |warm )?water|(hot |warm )?water (is )?(not|n['’]?t|doesn['’]?t|does not|won['’]?t|stopped)|water (is )?not running|only cold water|leak\w*|flood\w*|burst pipe|nejde (teplá |tepla )?voda|neteče (teplá |tepla )?voda|netece (tepla )?voda|není (teplá )?voda|neni (tepla )?voda|teče voda|tece voda|vytopen\w*|kein (warm)?wasser|wasserschaden)/i,
  },
  {
    label: 'safety — fire / gas / smoke / police',
    // Not bare "smoke" / "plyn" — "can we smoke on the balcony?" and a gas
    // hob question are not emergencies.
    re: /(on fire|a fire\b|fire alarm|smoke alarm|smells? (of )?(gas|smoke|burning)|gas leak|break[- ]?in|burglar\w*|stolen|ambulance|injur\w*|požár|pozar|hoří|hori\b|zápach plynu|zapach plynu|cítíme plyn|citime plyn|únik plynu|unik plynu|kouří se|vykraden\w*|ukraden\w*|sanitk\w*|zraněn\w*|zranen\w*|brand\b|gasgeruch|einbruch|gestohlen)/i,
  },
  {
    label: 'toilet / no access to apartment',
    re: /(toilet (is )?(blocked|clogged|overflow\w*)|ucpan\w* (záchod|zachod|wc)|záchod nefunguje|zachod nefunguje|apartment (is )?(not ready|occupied|dirty)|someone (is )?(in|already in) (our|the) (apartment|room)|byt (je )?obsazen\w*)/i,
  },
];

export interface UrgencyResult {
  urgent: boolean;
  /** Matched keyword families, for the alert text. Empty when only the
   *  classifier flagged it. */
  labels: string[];
}

/** Deterministic keyword pass. */
export function matchUrgentKeywords(text: string): UrgencyResult {
  const t = (text ?? '').slice(0, 4000);
  const labels = URGENT_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.label);
  return { urgent: labels.length > 0, labels };
}

/** Combine the classifier's flag with the keyword pass. */
export function assessUrgency(
  text: string,
  classifier?: { urgent?: boolean; urgentReason?: string } | null,
): UrgencyResult {
  const kw = matchUrgentKeywords(text);
  const labels = [...kw.labels];
  if (classifier?.urgent && classifier.urgentReason) labels.unshift(classifier.urgentReason);
  return { urgent: kw.urgent || !!classifier?.urgent, labels };
}
