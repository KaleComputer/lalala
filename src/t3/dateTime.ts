// Standalone stand-in for effect/DateTime: the bridge sends ISO strings.
export const toEpochMillis = (value: string | number | Date): number =>
  typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value);
