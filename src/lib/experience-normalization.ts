export const normalizeExperienceTitle = (title: string) =>
  title.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();

type LegacyExperienceRow = {
  id: string;
  materialId: string;
  type: string;
  title: string;
  status: string;
  updatedAt: number;
};

export function planLegacyDraftKeys(rows: readonly LegacyExperienceRow[]): Map<string, string> {
  const groups = new Map<string, LegacyExperienceRow[]>();
  for (const row of rows) {
    if (row.status !== "draft") continue;
    const normalized = normalizeExperienceTitle(row.title);
    const groupKey = `${row.materialId}\0${row.type}\0${normalized}`;
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }
  const result = new Map<string, string>();
  for (const group of groups.values()) {
    group.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    const normalized = normalizeExperienceTitle(group[0].title);
    group.forEach((row, index) => {
      result.set(row.id, index === 0 ? normalized : `${normalized}#legacy:${row.id}`);
    });
  }
  return result;
}