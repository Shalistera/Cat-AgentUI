/** Old tabs/imports must not reintroduce retired experiment preferences. */
export function cleanUserSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const settings = { ...value } as Record<string, unknown>;
  delete settings.canvasAnswers;
  delete settings.showThoughtSignatures;
  return settings;
}
