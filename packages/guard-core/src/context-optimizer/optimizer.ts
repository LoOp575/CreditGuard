export interface ContextSection { id: string; content: string; priority: number; required?: boolean; }
export interface ContextOptimizeInput { sections: ContextSection[]; maxCharacters: number; }
export interface ContextOptimizeResult { text: string; includedIds: string[]; omittedIds: string[]; inputCharacters: number; outputCharacters: number; reductionPercent: number; limitExceeded: boolean; }
export class ContextOptimizer {
  optimize(input: ContextOptimizeInput): ContextOptimizeResult {
    if (!Number.isSafeInteger(input.maxCharacters) || input.maxCharacters < 0) throw new TypeError("maxCharacters must be a non-negative integer");
    const seen = new Set<string>();
    for (const section of input.sections) {
      if (!section.id.trim()) throw new TypeError("section id must not be empty");
      if (seen.has(section.id)) throw new TypeError("duplicate section id: " + section.id);
      seen.add(section.id);
      if (!Number.isFinite(section.priority) || section.priority < 1 || section.priority > 5) throw new TypeError("priority must be between 1 and 5");
    }
    const render = (s: ContextSection) => `[${s.id}]\n${s.content}`;
    const inputText = input.sections.map(render).join("\n\n");
    const selected = new Set<string>();
    let used = 0;
    for (const s of input.sections.filter(x => x.required)) {
      const cost = render(s).length + (selected.size ? 2 : 0);
      selected.add(s.id); used += cost;
    }
    const optional = input.sections.filter(x => !x.required).sort((a,b) => b.priority-a.priority || input.sections.indexOf(a)-input.sections.indexOf(b));
    for (const s of optional) {
      const cost = render(s).length + (selected.size ? 2 : 0);
      if (used + cost <= input.maxCharacters) { selected.add(s.id); used += cost; }
    }
    const included = input.sections.filter(s => selected.has(s.id));
    const omittedIds = input.sections.filter(s => !selected.has(s.id)).map(s => s.id);
    const text = included.map(render).join("\n\n");
    const outputCharacters = text.length;
    const inputCharacters = inputText.length;
    return { text, includedIds: included.map(s=>s.id), omittedIds, inputCharacters, outputCharacters,
      reductionPercent: inputCharacters ? Math.round((1-outputCharacters/inputCharacters)*10000)/100 : 0,
      limitExceeded: outputCharacters > input.maxCharacters };
  }
}
