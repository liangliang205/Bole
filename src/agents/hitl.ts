import { createInterface } from 'node:readline/promises';

export interface HitlQuestion {
  id: string;
  node: string;
  question: string;
  options: string[];
  recommendedOption: string;
  blocking: boolean;
}

export interface HitlAnswer {
  answer: string;
  actor: string;
}

export interface HitlResponder {
  ask(question: HitlQuestion): Promise<HitlAnswer>;
}

/** 非交互模式：自动采纳推荐选项，actor 明确标注是自动应答（审计可区分真人与自动）。 */
export class AutoHitlResponder implements HitlResponder {
  private answers: Map<string, string>;

  constructor(preset: Record<string, string> = {}) {
    this.answers = new Map(Object.entries(preset));
  }

  async ask(question: HitlQuestion): Promise<HitlAnswer> {
    const preset = this.answers.get(question.id);
    return {
      answer: preset ?? question.recommendedOption,
      actor: 'HR(auto-demo)',
    };
  }
}

export class ConsoleHitlResponder implements HitlResponder {
  private rl: ReturnType<typeof createInterface>;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  async ask(question: HitlQuestion): Promise<HitlAnswer> {
    const optionList = question.options
      .map((option, index) => `  ${index + 1}) ${option}${option === question.recommendedOption ? '（推荐）' : ''}`)
      .join('\n');
    process.stdout.write(`\n【HITL 需要你确认】${question.node}\n${question.question}\n${optionList}\n请选择编号（回车=推荐项）: `);
    const line = (await this.rl.question('')).trim();
    if (!line) return { answer: question.recommendedOption, actor: 'HR(console)' };
    const index = Number(line);
    if (Number.isInteger(index) && index >= 1 && index <= question.options.length) {
      return { answer: question.options[index - 1], actor: 'HR(console)' };
    }
    return { answer: line, actor: 'HR(console)' };
  }

  close(): void {
    this.rl.close();
  }
}
