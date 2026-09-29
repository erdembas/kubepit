const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Native variants can be arbitrary strings. Order only recognized reasoning levels. */
export function agentEffortLevels(values: string[]) {
  const levels = [...new Set(values.filter(Boolean))];
  const ordered = levels.length > 0 && levels.every((value) => effortOrder.includes(value));
  return {
    ordered,
    levels: ordered
      ? levels.sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))
      : levels,
  };
}
