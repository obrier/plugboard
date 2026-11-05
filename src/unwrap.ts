// A tool's MCP result as one value, for the core and the CLI alike.
const tryJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

/** One shape for every connector: structuredContent, a JSON string, or text blocks holding JSON (Slack). */
export function unwrap(result: Record<string, any>): unknown {
  const structured = result.structuredContent;
  if (structured !== null && typeof structured === "object" && !Array.isArray(structured)) return structured;
  if (typeof result.content === "string") return tryJson(result.content) ?? { text: result.content };
  if (Array.isArray(result.content)) {
    const texts = result.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text as string);
    if (texts.length && texts.length === result.content.length) {
      const parsed = texts.map(tryJson);
      if (parsed.every(p => p !== undefined)) return parsed.length === 1 ? parsed[0] : parsed;
      return { text: texts.join("\n\n") };
    }
    return { content: result.content };
  }
  return structured ?? {};
}

export function errorText(result: Record<string, any>): string {
  const value = unwrap(result);
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as any).text === "string") return (value as any).text;
  return JSON.stringify(value).slice(0, 500);
}
