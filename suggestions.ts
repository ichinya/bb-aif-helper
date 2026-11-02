// Suggest command names only: surrounding prose and shell/skill arguments are
// never promoted into an executable request. A click still requires server checks.
export function extractAifCommands(text: string): string[] {
  const result: string[] = [];
  for (const match of text.slice(0, 1024 * 1024).matchAll(/(?<![\w$\\/.-])\$(aif(?:-[a-z0-9]+)*)(?![\w/-])/g)) {
    const name = match[1];
    if (name.length <= 100 && !result.includes(name)) result.push(name);
    if (result.length === 12) break;
  }
  return result;
}
