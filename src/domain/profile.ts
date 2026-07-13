export interface ProfileFact {
  id: string;
  field: string;
  value: string;
  source: string;
  confidence: number;
  confirmed: boolean;
}

export function confirmProfileFacts(facts: ProfileFact[], ids: string[]): ProfileFact[] {
  const selected = new Set(ids);
  return facts.map((fact) => selected.has(fact.id) ? { ...fact, confirmed: true } : fact);
}

export function findFactConflicts(facts: ProfileFact[]) {
  const grouped = new Map<string, ProfileFact[]>();
  for (const fact of facts) grouped.set(fact.field, [...(grouped.get(fact.field) ?? []), fact]);
  return [...grouped.entries()]
    .filter(([, values]) => new Set(values.map((fact) => fact.value.trim())).size > 1)
    .map(([field, values]) => ({ field, factIds: values.map((fact) => fact.id) }));
}
